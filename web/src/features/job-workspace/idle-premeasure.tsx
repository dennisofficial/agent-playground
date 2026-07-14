"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createContext } from "react";
import type { Virtualizer } from "@tanstack/react-virtual";
import { warmMermaidDiagrams } from "./markdown";

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
/** Within this many px of the bottom counts as "pinned to the tail" — matches useTailFollow's 80px band. */
const AT_BOTTOM_PX = 80;
/** `requestIdleCallback` timeout so a chunk isn't starved indefinitely on a busy main thread. */
const IDLE_TIMEOUT_MS = 200;

type PremeasureItem = { key: string; node: React.ReactNode };

/** Bottom-up scan for the next `chunkSize` not-yet-measured row indexes (returned top-to-bottom for a
 *  natural DOM render order). Pure + exported for unit testing. */
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

/** Schedule `cb` during idle time — `requestIdleCallback` where available (desktop), else a MessageChannel
 *  yielder (iOS Safari has no default `requestIdleCallback`). Returns a cancel function. */
function scheduleIdle(cb: () => void): () => void {
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

type Virt = Virtualizer<HTMLDivElement, Element>;

/**
 * Off-screen pre-measurement that gives every not-yet-seen transcript row its EXACT height BEFORE the user
 * scrolls into it, so a fresh tall row (long markdown/code, a Mermaid diagram) never triggers a
 * first-measure resize / scroll-compensation on iOS. Returns the hidden measurement layer to render inside
 * the transcript's content column, or `null` once done / disabled (zero cost).
 *
 * Two strictly-separated phases — this split is the whole point:
 *   1. MEASURE (idle, invisible): render the backlog off-screen in bottom-up chunks and record each row's
 *      `offsetHeight` into a map. This NEVER calls `resizeItem`, so it never changes the live virtualizer's
 *      total size and never moves the scroll position — nothing is visible, no matter where the user is.
 *   2. SEED (one synchronous burst): once every row is measured, apply ALL heights via `resizeItem` in a
 *      single synchronous loop. The many above-viewport scroll-position corrections it triggers are
 *      coalesced by the browser into ONE paint — a single, barely-perceptible settle — instead of the
 *      hundreds of separate frames (the visible "jumping on load") that a measure-and-seed-per-chunk pass
 *      produced. If the view is pinned at the tail, it re-pins to the bottom on the next frame so the settle
 *      leaves the latest message exactly where it was.
 */
export function useIdlePremeasure(opts: {
  items: PremeasureItem[];
  virtualizer: Virt;
  enabled: boolean;
  chunkSize?: number;
  /** ```mermaid fence sources found anywhere in the transcript (deduped by the warm helper itself). Warmed
   *  off-screen before MEASURE runs, so a Mermaid row's `offsetHeight` reflects its REAL rendered height
   *  instead of the cold placeholder. */
  warmSources?: string[];
}): React.ReactNode {
  const { items, virtualizer, enabled, chunkSize = DEFAULT_CHUNK_SIZE, warmSources } = opts;

  const measuredRef = useRef<Map<string, number>>(new Map());
  const [seeded, setSeeded] = useState(false);
  // Rows measured so far, counted from the tail up. The hidden layer renders the next unmeasured chunk.
  const [cursor, setCursor] = useState(0);
  const layerRef = useRef<HTMLDivElement>(null);
  // Gates MEASURE (not just SEED): a Mermaid row rendered before its diagram is warm would still read its
  // cold placeholder height, reproducing the exact bug this pass exists to fix.
  const [warmed, setWarmed] = useState(false);

  // Re-arm from the tail whenever the top of the list changes identity (older history prepended) — a plain
  // append leaves the backlog untouched (new tail rows measure on-screen normally), so it must NOT re-run.
  const topKey = items[0]?.key ?? null;
  const prevTopKey = useRef(topKey);
  if (prevTopKey.current !== topKey) {
    prevTopKey.current = topKey;
    measuredRef.current = new Map();
    if (seeded) setSeeded(false);
    if (cursor !== 0) setCursor(0);
    if (warmed) setWarmed(false);
  }

  // WARM phase: render every not-yet-cached diagram off-screen (idle-scheduled) before MEASURE reads any
  // row's offsetHeight. Runs once per arming; a transcript with no diagrams warms trivially (empty list).
  useEffect(() => {
    if (!enabled || warmed) return;
    const list = warmSources ?? [];
    if (list.length === 0) {
      setWarmed(true);
      return;
    }
    let cancelled = false;
    const cancelIdle = scheduleIdle(() => {
      void warmMermaidDiagrams(list).finally(() => {
        if (!cancelled) setWarmed(true);
      });
    });
    return () => {
      cancelled = true;
      cancelIdle();
    };
  }, [enabled, warmed, warmSources]);

  const measuring = enabled && warmed && !seeded && items.length > 0;
  // The next bottom-up chunk of not-yet-measured rows. `cursor` is how many rows (from the tail) are already
  // handled; the scan starts just above that and skips anything already in the map.
  const chunkIndexes = measuring
    ? premeasureChunkIndexes(items, items.length - cursor, chunkSize, (key) =>
        measuredRef.current.has(key),
      )
    : [];
  const active = chunkIndexes.length > 0;

  useLayoutEffect(() => {
    if (!measuring) return;

    if (active) {
      // Record the rendered chunk's heights (measure only — never `resizeItem` here, so the live
      // virtualizer's total size and the scroll position are untouched and nothing is visible).
      const layer = layerRef.current;
      if (layer) {
        layer.querySelectorAll<HTMLElement>("[data-pindex]").forEach((el) => {
          const idx = Number(el.getAttribute("data-pindex"));
          const item = items[idx];
          if (item) measuredRef.current.set(item.key, el.offsetHeight);
        });
      }
      // Advance above the chunk we just measured, then schedule the next one on idle time.
      const nextCursor = items.length - chunkIndexes[0];
      const cancel = scheduleIdle(() => setCursor(nextCursor));
      return cancel;
    }

    // No unmeasured rows left → the whole backlog is measured → SEED every row in ONE synchronous loop. The
    // many above-viewport scroll-position corrections `resizeItem` triggers are coalesced by the browser into
    // a single paint (one barely-perceptible settle) rather than the hundreds of separate frames that read as
    // "jumping on load".
    const el = virtualizer.scrollElement;
    const wasAtBottom =
      !!el && el.scrollHeight - el.scrollTop - el.clientHeight < AT_BOTTOM_PX;
    for (let i = 0; i < items.length; i++) {
      const h = measuredRef.current.get(items[i].key);
      if (h != null) virtualizer.resizeItem(i, h);
    }
    // Keep the latest message pinned across the settle (anchorTo:'end' should already hold it; this is a
    // belt-and-suspenders re-pin for the tail case).
    if (wasAtBottom && el) {
      requestAnimationFrame(() => {
        el.scrollTop = el.scrollHeight;
      });
    }
    setSeeded(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [measuring, active, cursor]);

  if (!active) return null;

  const lo = chunkIndexes[0];
  const hi = chunkIndexes[chunkIndexes.length - 1] + 1;

  return (
    <div
      ref={layerRef}
      aria-hidden
      style={{
        position: "absolute",
        visibility: "hidden",
        left: -99999,
        top: 0,
        width: "100%",
      }}
    >
      <PremeasureContext.Provider value={true}>
        {items.slice(lo, hi).map((it, i) => (
          <div
            key={it.key}
            data-pindex={lo + i}
            className="w-full"
            style={{ paddingBottom: ROW_PADDING_BOTTOM }}
          >
            {it.node}
          </div>
        ))}
      </PremeasureContext.Provider>
    </div>
  );
}
