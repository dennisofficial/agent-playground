"use client";

import { useCallback, useEffect, useState, useSyncExternalStore } from "react";

/**
 * LIVE engine-stream store — the in-flight turn of a thread's in-sandbox Claude Code session, made
 * RESUMABLE.
 *
 * The repo SSE (`…/repos/:repoId/events`) carries `{ type:'stream', jobId, seq, event }` frames:
 *   - `event.kind === 'snapshot'` — the full cumulative turn state, replayed the moment THIS client
 *     connects (first load / refresh / navigate-back / network blip). This is what lets a long response
 *     keep streaming after a reconnect: the producing turn runs server-side independent of the
 *     connection, so on reconnect we catch up to the current state instead of seeing nothing.
 *   - `event.kind === 'turn_start'` — the FIRST frame of a turn: marks the lane active + records the
 *     turn's `startedAt` (epoch ms) so the working indicator flips on and can tick an elapsed timer. The
 *     reconnect snapshot ALSO carries `startedAt`, so elapsed survives refresh/reconnect.
 *   - delta kinds (`text_delta`/`thinking`/`tool_use`/`tool_result`/…) — applied on top, live.
 *   - `turn_end` — handled in `job-events.ts` (refetch `/messages`, then `endLiveTurn`).
 *
 * `seq` is a server-global monotonic counter. We keep the max applied `seq` per thread and ignore any
 * frame with `seq <= lastSeq`, so the snapshot-then-live merge (and any duplicate replay) is race-free.
 * Mirrors the external-store pattern in `thread-status.ts`.
 */

export type LiveBlock =
  // `parentToolUseId` (set only for SUBAGENT blocks) lets the live view peel a subagent's activity out of
  // the main turn into its own card / sub-page — mirrors the durable `meta.parentToolUseId`.
  | {
      kind: "text";
      key: string;
      text: string;
      done: boolean;
      parentToolUseId?: string;
    }
  | {
      kind: "thinking";
      key: string;
      text: string;
      done: boolean;
      parentToolUseId?: string;
    }
  | {
      kind: "tool";
      key: string;
      toolId?: string;
      name: string;
      input?: unknown;
      result?: unknown;
      isError?: boolean;
      /** Edit/MultiEdit only: structured patch (real file offsets) for the diff body. */
      structuredPatch?: unknown;
      done: boolean;
      parentToolUseId?: string;
    };

export interface LiveTurn {
  blocks: LiveBlock[];
  /** True while streaming; false after `turn_end` (kept until the durable refetch clears it). */
  active: boolean;
  /** Highest frame `seq` applied to this turn. */
  lastSeq: number;
  /**
   * Epoch-ms the turn started (from the `turn_start` frame, or the reconnect `snapshot`'s `startedAt`).
   * Drives the working-indicator elapsed timer; `undefined` until the first frame that carries it.
   */
  startedAt?: number;
  /**
   * LIVE context-window occupancy — updated mid-turn from each `usage` frame (Claude turns) so the composer
   * ring fills DURING the turn. `undefined` until the turn's first `usage` frame; the durable `turn_meta`
   * (from the last completed turn) is the footer's fallback baseline until then. Reset per turn.
   */
  contextTokens?: number;
  contextModel?: string;
  contextLimit?: number;
  /**
   * Per-SUBAGENT live occupancy, keyed by the subagent's spawning Task id (`parentToolUseId`). Each running
   * subagent reports its OWN context ring separately from the main-agent ring above — a `usage` frame that
   * carries `parentToolUseId` lands here instead of the top-level fields. Consumed by `SubagentCard`.
   */
  subUsage?: Record<
    string,
    { contextTokens: number; contextModel?: string; contextLimit: number }
  >;
}

type StreamPayload = {
  kind?: string;
  text?: string;
  id?: string;
  name?: string;
  input?: unknown;
  result?: unknown;
  isError?: boolean;
  /** present on a `tool_result` for an Edit/MultiEdit — real file offsets for the diff gutter. */
  structuredPatch?: unknown;
  /** set only for subagent blocks (the spawning Task id) — peeled into a sub-page by consumers. */
  parentToolUseId?: string;
  /** present on `kind:'snapshot'` */
  blocks?: LiveBlock[];
  active?: boolean;
  /** present on `kind:'turn_start'` and (for reconnect resilience) `kind:'snapshot'` — epoch-ms turn start. */
  startedAt?: number;
  /** present on `kind:'usage'` — live mid-turn context-window occupancy. */
  contextTokens?: number;
  contextModel?: string;
  contextLimit?: number;
};

let blockSeq = 0;

/** The default lane — the thread brain's conversational turn (vs `phase:<stepId>` for a build turn). */
export const MAIN_LANE = "main";
/** The store keys an in-flight turn by thread AND lane, so a brain turn and a build turn coexist. */
const laneKey = (jobId: string, lane: string): string => `${jobId}::${lane}`;

/**
 * ms after an SSE reconnect before un-reconfirmed turns are swept. The server replays its snapshots as
 * the FIRST frames after connect, so anything genuinely live is re-stamped well within this window.
 */
const RECONNECT_SWEEP_GRACE_MS = 3_000;

class ThreadStreamStore {
  /** key: `${jobId}::${lane}` → that lane's in-flight turn. */
  private map = new Map<string, LiveTurn>();
  /** Reconnect-sweep bookkeeping: the current sweep epoch + the epoch each key was last fed in. */
  private epoch = 0;
  private readonly touchedEpoch = new Map<string, number>();
  private sweepTimer: ReturnType<typeof setTimeout> | null = null;
  /**
   * Per-key listeners. The repo SSE feeds frames for EVERY in-flight turn in the repo into this one store
   * (so switching to a sibling thread mid-stream is instant — its snapshot+deltas are already here). To
   * keep that cheap, a `useLiveTurn(jobId, lane)` subscriber re-renders ONLY when ITS key changes, not
   * on every other thread's token — so a busy sibling never churns the open conversation.
   */
  private readonly keyListeners = new Map<string, Set<() => void>>();

  /** Apply a `{type:'stream'}` frame's event (snapshot or delta) for a turn lane, deduped by `seq`. */
  apply(
    jobId: string,
    lane: string,
    seq: number,
    ev: StreamPayload | null | undefined,
  ): void {
    if (!jobId || !ev?.kind) return;
    const key = laneKey(jobId, lane);
    // Any frame for this key proves the server still knows the turn — re-confirms it for the sweep.
    this.touchedEpoch.set(key, this.epoch);
    const cur = this.map.get(key);

    // `turn_start` — the FIRST frame of a turn. Mark the lane active + record the authoritative start time
    // so the working indicator can flip ON immediately and tick an elapsed timer. Preserve any blocks a
    // (rare) out-of-order earlier frame already produced; just stamp active + startedAt.
    if (ev.kind === "turn_start") {
      if (cur && seq <= cur.lastSeq) return;
      this.map.set(key, {
        blocks: cur?.blocks ?? [],
        active: true,
        lastSeq: seq,
        startedAt: ev.startedAt ?? cur?.startedAt ?? Date.now(),
      });
      this.notify(key);
      return;
    }

    // Snapshot: the authoritative full state at `seq`. Replace, unless we already have newer deltas.
    if (ev.kind === "snapshot") {
      if (cur && seq < cur.lastSeq) return;
      this.map.set(key, {
        blocks: (ev.blocks ?? []).map((b) => ({ ...b })),
        active: ev.active ?? true,
        lastSeq: seq,
        // The reconnect snapshot now carries `startedAt` so elapsed survives refresh/reconnect; fall back
        // to any value we already had, so a snapshot missing it doesn't reset the timer.
        startedAt: ev.startedAt ?? cur?.startedAt,
      });
      this.notify(key);
      return;
    }

    // Deltas are ordered + monotonic; drop anything already reflected (e.g. covered by a snapshot).
    if (cur && seq <= cur.lastSeq) return;

    const blocks = cur ? [...cur.blocks] : [];
    const last = blocks[blocks.length - 1];
    const text = typeof ev.text === "string" ? ev.text : "";
    // Only merge into the open block when it belongs to the SAME author (brain vs a given subagent), so a
    // subagent's forwarded text never appends onto the brain's open text block (or another subagent's).
    const pid = ev.parentToolUseId;
    const sameAuthor = (b: LiveBlock | undefined): boolean =>
      !!b && b.parentToolUseId === pid;
    // Finalize the most-recent still-open block of this kind+author. Interleaved thinking (auto-enabled by
    // adaptive thinking) means a turn can have TWO open delta blocks at once — an open `thinking` and an open
    // `text` — so the authoritative block we're closing is NOT necessarily `last`. Checking only `last` here
    // pushed a duplicate instead of merging (the "double stream" bug). Scan back for the matching open block.
    const finalizeOpen = (kind: "text" | "thinking"): boolean => {
      for (let i = blocks.length - 1; i >= 0; i--) {
        const b = blocks[i];
        if (b.kind === kind && !b.done && b.parentToolUseId === pid) {
          blocks[i] = { ...b, text, done: true };
          return true;
        }
      }
      return false;
    };

    switch (ev.kind) {
      case "text_delta":
        if (last && last.kind === "text" && !last.done && sameAuthor(last))
          blocks[blocks.length - 1] = { ...last, text: last.text + text };
        else
          blocks.push({
            kind: "text",
            key: `c${blockSeq++}`,
            text,
            done: false,
            parentToolUseId: pid,
          });
        break;
      case "text":
        if (!finalizeOpen("text"))
          blocks.push({
            kind: "text",
            key: `c${blockSeq++}`,
            text,
            done: true,
            parentToolUseId: pid,
          });
        break;
      case "thinking_delta":
        if (last && last.kind === "thinking" && !last.done && sameAuthor(last))
          blocks[blocks.length - 1] = { ...last, text: last.text + text };
        else
          blocks.push({
            kind: "thinking",
            key: `c${blockSeq++}`,
            text,
            done: false,
            parentToolUseId: pid,
          });
        break;
      case "thinking":
        if (!finalizeOpen("thinking"))
          blocks.push({
            kind: "thinking",
            key: `c${blockSeq++}`,
            text,
            done: true,
            parentToolUseId: pid,
          });
        break;
      case "tool_use":
        blocks.push({
          kind: "tool",
          key: `c${blockSeq++}`,
          toolId: typeof ev.id === "string" ? ev.id : "",
          name: typeof ev.name === "string" ? ev.name : "tool",
          input: ev.input,
          done: false,
          parentToolUseId: pid,
        });
        break;
      case "tool_result": {
        const id = typeof ev.id === "string" ? ev.id : "";
        for (let i = blocks.length - 1; i >= 0; i--) {
          const b = blocks[i];
          if (b.kind === "tool" && !b.done && (b.toolId === id || id === "")) {
            blocks[i] = {
              ...b,
              result: ev.result,
              isError: Boolean(ev.isError),
              ...(ev.structuredPatch !== undefined
                ? { structuredPatch: ev.structuredPatch }
                : {}),
              done: true,
            };
            break;
          }
        }
        break;
      }
      case "usage": {
        // LIVE context occupancy — update the ring values, keep blocks untouched. Preferred over the durable
        // turn_meta by the composer footer while the turn is active. A `usage` frame tagged with
        // `parentToolUseId` is a SUBAGENT's own occupancy → route it into `subUsage[parentId]` and leave the
        // main-agent ring untouched; an untagged frame updates the main-agent ring.
        const subPid = ev.parentToolUseId;
        if (typeof subPid === "string") {
          this.map.set(key, {
            blocks,
            active: true,
            lastSeq: seq,
            startedAt: cur?.startedAt,
            contextTokens: cur?.contextTokens,
            contextModel: cur?.contextModel,
            contextLimit: cur?.contextLimit,
            subUsage: {
              ...cur?.subUsage,
              [subPid]: {
                contextTokens:
                  typeof ev.contextTokens === "number"
                    ? ev.contextTokens
                    : (cur?.subUsage?.[subPid]?.contextTokens ?? 0),
                contextModel:
                  typeof ev.contextModel === "string"
                    ? ev.contextModel
                    : cur?.subUsage?.[subPid]?.contextModel,
                contextLimit:
                  typeof ev.contextLimit === "number"
                    ? ev.contextLimit
                    : (cur?.subUsage?.[subPid]?.contextLimit ?? 0),
              },
            },
          });
          this.notify(key);
          return;
        }
        this.map.set(key, {
          blocks,
          active: true,
          lastSeq: seq,
          startedAt: cur?.startedAt,
          contextTokens:
            typeof ev.contextTokens === "number" ? ev.contextTokens : cur?.contextTokens,
          contextModel:
            typeof ev.contextModel === "string" ? ev.contextModel : cur?.contextModel,
          contextLimit:
            typeof ev.contextLimit === "number" ? ev.contextLimit : cur?.contextLimit,
          subUsage: cur?.subUsage,
        });
        this.notify(key);
        return;
      }
      default:
        // session / result — advance seq but don't change rendered blocks.
        this.map.set(key, {
          blocks,
          active: true,
          lastSeq: seq,
          startedAt: cur?.startedAt,
          contextTokens: cur?.contextTokens,
          contextModel: cur?.contextModel,
          contextLimit: cur?.contextLimit,
          subUsage: cur?.subUsage,
        });
        this.notify(key);
        return;
    }

    this.map.set(key, {
      blocks,
      active: true,
      lastSeq: seq,
      startedAt: cur?.startedAt,
      // Carry the live occupancy across block deltas so a text/tool frame doesn't wipe the ring mid-turn.
      contextTokens: cur?.contextTokens,
      contextModel: cur?.contextModel,
      contextLimit: cur?.contextLimit,
      subUsage: cur?.subUsage,
    });
    this.notify(key);
  }

  end(jobId: string, lane: string): void {
    const key = laneKey(jobId, lane);
    this.touchedEpoch.delete(key);
    if (!this.map.has(key)) return;
    this.map.delete(key);
    this.notify(key);
  }

  /**
   * Reconnect reconciliation for turns that ENDED while the SSE was down. On (re)connect the server
   * replays a snapshot for every turn still in flight — but nothing for one that finished (or was lost
   * to a backend restart), so its client copy would sit at `active: true` ("working…") forever. Bump the
   * epoch, give the snapshots a grace window to re-stamp their lanes, then drop whatever wasn't
   * re-confirmed. Lanes owned by OTHER repos' (currently closed) streams get dropped too — harmless:
   * reopening that repo's stream replays their snapshots fresh.
   */
  sweepAfterReconnect(): void {
    this.epoch += 1;
    const sweepEpoch = this.epoch;
    if (this.sweepTimer) clearTimeout(this.sweepTimer);
    this.sweepTimer = setTimeout(() => {
      this.sweepTimer = null;
      for (const key of [...this.map.keys()]) {
        if ((this.touchedEpoch.get(key) ?? 0) < sweepEpoch) {
          this.touchedEpoch.delete(key);
          this.map.delete(key);
          this.notify(key);
        }
      }
    }, RECONNECT_SWEEP_GRACE_MS);
  }

  /** Current turn for a key — a stable object ref until that key next changes (safe for useSyncExternalStore). */
  getByKey(key: string): LiveTurn | undefined {
    return this.map.get(key);
  }

  get(jobId: string, lane: string): LiveTurn | undefined {
    return this.map.get(laneKey(jobId, lane));
  }

  private notify(key: string): void {
    this.keyListeners.get(key)?.forEach((l) => l());
  }

  subscribeKey(key: string, cb: () => void): () => void {
    let set = this.keyListeners.get(key);
    if (!set) {
      set = new Set();
      this.keyListeners.set(key, set);
    }
    set.add(cb);
    return () => {
      const s = this.keyListeners.get(key);
      if (!s) return;
      s.delete(cb);
      if (s.size === 0) this.keyListeners.delete(key);
    };
  }
}

const store = new ThreadStreamStore();

/** Feed one `{type:'stream'}` frame (snapshot or delta) into a thread's live turn lane. */
export function applyStreamFrame(
  jobId: string,
  lane: string,
  seq: number,
  event: unknown,
): void {
  store.apply(jobId, lane, seq, event as StreamPayload);
}

/** Clear a thread's live turn lane — call AFTER the durable `/messages` refetch lands (post `turn_end`). */
export function endLiveTurn(jobId: string, lane: string = MAIN_LANE): void {
  store.end(jobId, lane);
}

/**
 * Call on a genuine SSE (re)connect (NOT on a late-join to an already-open stream): after a grace window
 * for the server's replayed snapshots, clears any live turn the reconnect didn't re-confirm — a turn that
 * ended (or died with a backend restart) while we were disconnected.
 */
export function sweepLiveTurnsAfterReconnect(): void {
  store.sweepAfterReconnect();
}

/**
 * Subscribe to one thread's in-flight live turn for a lane (default the brain's `main` turn). The
 * conversation reads `main`; a step sub-page reads its `phase:<stepId>` lane.
 */
export function useLiveTurn(
  jobId: string,
  lane: string = MAIN_LANE,
): LiveTurn | undefined {
  const key = laneKey(jobId, lane);
  const subscribe = useCallback(
    (cb: () => void) => store.subscribeKey(key, cb),
    [key],
  );
  const getByKey = useCallback(() => store.getByKey(key), [key]);
  return useSyncExternalStore(subscribe, getByKey, () => undefined);
}

/** The short status word for the working indicator, derived from the LAST live block's kind. */
export type LiveStatusWord = "still thinking" | "using tools" | "responding";

/**
 * A compact summary of a live turn for the "Atlas is working…" indicator (Claude-Code style):
 *  - `openTools` — tool_use blocks with no tool_result yet (in-flight tool calls, incl. subagent/Task runs).
 *  - `statusWord` — from the last block's kind (thinking → "still thinking", tool → "using tools",
 *    text → "responding").
 * The block model doesn't pair tool_use↔tool_result by matching frames; instead each tool block carries a
 * `done` flag (flipped when its `tool_result` lands), so an open tool = a `tool` block with `done === false`.
 */
export function summarizeLiveTurn(turn: LiveTurn | undefined): {
  openTools: number;
  statusWord: LiveStatusWord;
} {
  const blocks = turn?.blocks ?? [];
  let openTools = 0;
  for (const b of blocks) if (b.kind === "tool" && !b.done) openTools += 1;
  const last = blocks[blocks.length - 1];
  const statusWord: LiveStatusWord =
    last?.kind === "thinking"
      ? "still thinking"
      : last?.kind === "tool"
        ? "using tools"
        : "responding";
  return { openTools, statusWord };
}

/**
 * A once-per-second elapsed-seconds ticker for a turn that started at `startedAt` (epoch ms). Returns 0
 * when `startedAt` is undefined. Recomputes from wall-clock each tick (not an accumulator), so it stays
 * correct across tab-throttling and reconnects. Cleans its interval up on unmount / when the turn ends.
 */
export function useElapsedSeconds(startedAt: number | undefined): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (startedAt == null) return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(id);
  }, [startedAt]);
  if (startedAt == null) return 0;
  return Math.max(0, Math.round((now - startedAt) / 1_000));
}

/**
 * Formats an elapsed-seconds count into a compact human-readable duration: `45s`, `19m 24s`, or
 * `1h 05m 24s`. Sub-minute durations stay bare seconds; once minutes/hours appear the smaller units are
 * zero-padded so the width stays stable as it ticks.
 */
export function formatElapsed(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  const hours = Math.floor(s / 3_600);
  const minutes = Math.floor((s % 3_600) / 60);
  const seconds = s % 60;
  if (hours > 0)
    return `${hours}h ${String(minutes).padStart(2, "0")}m ${String(seconds).padStart(2, "0")}s`;
  if (minutes > 0) return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
  return `${seconds}s`;
}
