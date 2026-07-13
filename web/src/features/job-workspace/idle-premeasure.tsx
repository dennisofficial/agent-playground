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
 *  compute this ONCE per mount (`useState(() => isTouchCapableDevice())`), not on every render. */
export function isTouchCapableDevice(): boolean {
  return typeof window !== "undefined" && window.matchMedia("(pointer: coarse)").matches;
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

/** Schedule `cb` during idle time — `requestIdleCallback` where available (desktop), else a MessageChannel
 *  yielder (iOS Safari has no default `requestIdleCallback`). Returns a cancel function. */
function scheduleChunk(cb: () => void): () => void {
  if (typeof requestIdleCallback === "function") {
    const handle = requestIdleCallback(cb, { timeout: IDLE_TIMEOUT_MS });
    return () => cancelIdleCallback(handle);
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
function isAtRest<TScrollElement extends Element | Window, TItemElement extends Element>(
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

  // Absolute index boundary: rows at index >= measuredLo have already been processed/seeded. `null` means
  // the pass hasn't advanced past its first chunk yet, so the boundary tracks the live tail (items.length)
  // — this must be an ABSOLUTE index, not a count-from-tail, because a tail-only append (new durable message
  // landing mid-pass) grows items.length without invalidating work already done further up; recomputing the
  // boundary as `items.length - <stale count>` would silently shift it past not-yet-measured appended rows
  // and skip them for the rest of the pass.
  const [measuredLo, setMeasuredLo] = useState<number | null>(null);
  const [done, setDone] = useState(false);

  // Re-arm guard: a genuine prepend (older history loaded) changes items[0]'s key — restart the pass from
  // the (new) tail. A tail-only append leaves items[0] unchanged and must NOT reset the pass.
  const firstKeyRef = useRef(items[0]?.key);
  useLayoutEffect(() => {
    const firstKey = items[0]?.key;
    if (firstKey !== firstKeyRef.current) {
      firstKeyRef.current = firstKey;
      setMeasuredLo(null);
      setDone(false);
    }
  }, [items]);

  const hi = measuredLo ?? items.length;
  const lo = Math.max(0, hi - chunkSize);
  const active = enabled && !done && items.length > 0;

  const layerRef = useRef<HTMLDivElement>(null);
  const touchingRef = useRef(false);

  // Keyed on [active, measuredLo] (NOT measuredLo alone): the transcript mounts with `messages = []`, so
  // `active` starts false; when hydration flips it true, `measuredLo` is still `null`, so a dep list without
  // `active` would never fire the first chunk.
  useLayoutEffect(() => {
    if (!active) return;

    const cache = (virtualizer as unknown as { itemSizeCache: Map<string, number> })
      .itemSizeCache;
    const layer = layerRef.current;
    if (layer) {
      layer.querySelectorAll<HTMLElement>("[data-pindex]").forEach((el) => {
        const idx = Number(el.getAttribute("data-pindex"));
        const item = items[idx];
        if (!item || cache.has(item.key)) return; // already seen/seeded — idempotent, cheap
        const h = el.offsetHeight;
        virtualizer.resizeItem(idx, h);
      });
    }

    if (lo <= 0) {
      setDone(true);
      return;
    }

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

    const advance = () => setMeasuredLo(lo);

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
  }, [active, measuredLo]);

  if (!active) return null;

  return (
    <div
      ref={layerRef}
      style={{ position: "absolute", visibility: "hidden", left: -99999, top: 0, width: "100%" }}
    >
      <PremeasureContext.Provider value={true}>
        {items.slice(lo, hi).map((item, i) => (
          <div
            key={item.key}
            data-pindex={lo + i}
            className="w-full"
            style={{ paddingBottom: ROW_PADDING_BOTTOM }}
          >
            {item.node}
          </div>
        ))}
      </PremeasureContext.Provider>
    </div>
  );
}
