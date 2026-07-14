"use client";

import { createContext, useLayoutEffect, useRef, useState } from "react";
import type { Virtualizer } from "@tanstack/react-virtual";

/** True inside the hidden off-screen pre-measurement layer below — rows rendered there are read for
 *  `offsetHeight` only and never actually seen, so components with mount-time side effects (attachment
 *  thumbnail fetches, etc.) should consult this and skip them there. Defaults to `false` for every normal,
 *  real (visible) render. */
export const PremeasureContext = createContext(false);

/** Row-count threshold below which the idle pre-measurement pass is skipped (decision: gate the pass on
 *  touch + transcript length — short transcripts have negligible residual shift). */
export const PREMEASURE_MIN_ROWS = 60;

/** Is this a touch-capable device? SSR-guarded. The residual scroll-up shift the pass eliminates is
 *  iOS/touch-only (desktop already compensates for above-viewport resizes immediately), so callers should
 *  compute this once after hydration, not during SSR and not on every render. */
export function isTouchCapableDevice(): boolean {
  return (
    typeof window !== "undefined" &&
    window.matchMedia("(pointer: coarse)").matches
  );
}

const DEFAULT_CHUNK_SIZE = 24;
/** Matches the real windowed row wrapper's bottom gap (conversation.tsx's `paddingBottom: 9`) so a row
 *  pre-measured here comes out the same height the live viewport will later measure for the same content. */
const ROW_PADDING_BOTTOM = 9;
/** How often to re-check "at rest" while a touch/scroll gesture holds up the next chunk. */
const REST_POLL_MS = 100;
/** `requestIdleCallback` timeout so a chunk isn't starved indefinitely on a busy main thread. */
const IDLE_TIMEOUT_MS = 200;

type PremeasureItem = { key: string; node: React.ReactNode };

export function premeasureChunkIndexes(
  items: ReadonlyArray<{ key: string }>,
  cursor: number,
  chunkSize: number,
  isMeasured: (key: string) => boolean,
): number[] {
  const indexes: number[] = [];
  for (
    let i = Math.min(cursor, items.length) - 1;
    i >= 0 && indexes.length < chunkSize;
    i--
  ) {
    if (!isMeasured(items[i].key)) indexes.push(i);
  }
  indexes.reverse();
  return indexes;
}

type PremeasureChunk = { indexes: number[] };

/** Schedule `cb` during idle time — `requestIdleCallback` where available (desktop), else a MessageChannel
 *  yielder (iOS Safari has no default `requestIdleCallback`). Returns a cancel function. */
function scheduleChunk(cb: () => void): () => void {
  if (typeof requestIdleCallback === "function") {
    const handle = requestIdleCallback(cb, { timeout: IDLE_TIMEOUT_MS });
    return () => cancelIdleCallback(handle);
  }
  if (typeof MessageChannel === "undefined") {
    const handle = setTimeout(cb, 0);
    return () => clearTimeout(handle);
  }
  const channel = new MessageChannel();
  let cancelled = false;
  channel.port2.onmessage = () => {
    if (!cancelled) cb();
  };
  channel.port1.postMessage(null);
  return () => {
    cancelled = true;
  };
}

/** Is the scroll container currently mid-touch or mid-scroll? Seeding an above-viewport row while either is
 *  true makes `resizeItem` trigger virtual-core's iOS-deferred scroll adjustment — exactly the jump this
 *  pass exists to eliminate — so the next chunk must wait until this reads true. */
function isAtRest<
  TScrollElement extends Element | Window,
  TItemElement extends Element,
>(
  virtualizer: Virtualizer<TScrollElement, TItemElement>,
  touching: { current: boolean },
): boolean {
  return !virtualizer.isScrolling && !touching.current;
}

/**
 * Idle, bottom-up, chunked off-screen measurement pass that pre-populates EXACT row heights for the
 * not-yet-seen backlog of a virtualized transcript, seeding them into the live virtualizer via
 * `resizeItem` (a no-op once a row's real height matches — `delta === 0`). This makes a fresh tall row
 * behave like an already-seen cached row when it later scrolls into view, so its first real measurement
 * never triggers an above-viewport scroll adjustment (the mechanism behind the iOS content-shift this
 * eliminates). Purely additive: never touches scroll position / tail-follow itself.
 *
 * Returns the hidden measurement layer to render inside the transcript's content column (a positioning
 * context), or `null` when `enabled` is false, the pass has completed, or there are no items — zero cost.
 */
export function useIdlePremeasure(opts: {
  items: PremeasureItem[];
  virtualizer: Virtualizer<HTMLDivElement, Element>;
  enabled: boolean;
  chunkSize?: number;
}): React.ReactNode {
  const { items, virtualizer, enabled, chunkSize = DEFAULT_CHUNK_SIZE } = opts;

  // Exclusive upper bound for the next bottom-up scan. Re-armed from the tail whenever a new unmeasured key
  // appears; only keys this pass has measured are skipped. The virtualizer's own size cache is not used as
  // a skip signal because it can contain non-premeasured entries; `resizeItem` is already idempotent when a
  // row was genuinely measured to the same exact height.
  const [chunk, setChunk] = useState<PremeasureChunk>({ indexes: [] });
  const measuredKeysRef = useRef<Set<string>>(new Set());

  useLayoutEffect(() => {
    if (!enabled) {
      setChunk({ indexes: [] });
      return;
    }
    const liveKeys = new Set(items.map((item) => item.key));
    for (const key of measuredKeysRef.current) {
      if (!liveKeys.has(key)) measuredKeysRef.current.delete(key);
    }
    const indexes = premeasureChunkIndexes(
      items,
      items.length,
      chunkSize,
      (key) => measuredKeysRef.current.has(key),
    );
    setChunk({ indexes });
  }, [enabled, items, chunkSize]);

  const chunkIndexes = chunk.indexes;
  const active = enabled && chunkIndexes.length > 0;

  const layerRef = useRef<HTMLDivElement>(null);
  const touchingRef = useRef(false);

  useLayoutEffect(() => {
    if (!active) return;

    const layer = layerRef.current;
    if (layer) {
      layer.querySelectorAll<HTMLElement>("[data-pindex]").forEach((el) => {
        const idx = Number(el.getAttribute("data-pindex"));
        const item = items[idx];
        if (!item || measuredKeysRef.current.has(item.key)) return;
        const h = el.offsetHeight;
        virtualizer.resizeItem(idx, h);
        measuredKeysRef.current.add(item.key);
      });
    }

    const nextCursor = chunkIndexes[0];

    let cancelScheduled: (() => void) | null = null;
    let pollTimer: ReturnType<typeof setTimeout> | null = null;
    let cancelled = false;

    const scrollEl = virtualizer.scrollElement;
    const onTouchStart = () => {
      touchingRef.current = true;
    };
    const onTouchEnd = () => {
      touchingRef.current = false;
    };
    scrollEl?.addEventListener("touchstart", onTouchStart, { passive: true });
    scrollEl?.addEventListener("touchend", onTouchEnd, { passive: true });
    scrollEl?.addEventListener("touchcancel", onTouchEnd, { passive: true });

    const advance = () => {
      setChunk({
        indexes: premeasureChunkIndexes(items, nextCursor, chunkSize, (key) =>
          measuredKeysRef.current.has(key),
        ),
      });
    };

    // Only advance to the next chunk once the container is at rest — mid-gesture, hold and poll instead of
    // scheduling, so a seed's adjustment always applies immediately/invisibly rather than getting deferred.
    const tryScheduleWhenAtRest = () => {
      if (cancelled) return;
      if (isAtRest(virtualizer, touchingRef)) {
        cancelScheduled = scheduleChunk(advance);
      } else {
        pollTimer = setTimeout(tryScheduleWhenAtRest, REST_POLL_MS);
      }
    };
    tryScheduleWhenAtRest();

    return () => {
      cancelled = true;
      cancelScheduled?.();
      if (pollTimer) clearTimeout(pollTimer);
      scrollEl?.removeEventListener("touchstart", onTouchStart);
      scrollEl?.removeEventListener("touchend", onTouchEnd);
      scrollEl?.removeEventListener("touchcancel", onTouchEnd);
    };
  }, [active, chunkIndexes, chunkSize, items, virtualizer]);

  if (!active) return null;

  return (
    <div
      ref={layerRef}
      style={{
        position: "absolute",
        visibility: "hidden",
        left: -99999,
        top: 0,
        width: "100%",
      }}
    >
      <PremeasureContext.Provider value={true}>
        {chunkIndexes.map((idx) => (
          <div
            key={items[idx].key}
            data-pindex={idx}
            className="w-full"
            style={{ paddingBottom: ROW_PADDING_BOTTOM }}
          >
            {items[idx].node}
          </div>
        ))}
      </PremeasureContext.Provider>
    </div>
  );
}
