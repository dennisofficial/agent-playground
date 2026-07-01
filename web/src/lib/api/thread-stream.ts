'use client';

import { useCallback, useSyncExternalStore } from 'react';

/**
 * LIVE engine-stream store — the in-flight turn of a thread's in-sandbox Claude Code session, made
 * RESUMABLE.
 *
 * The repo SSE (`…/repos/:repoId/events`) carries `{ type:'stream', jobId, seq, event }` frames:
 *   - `event.kind === 'snapshot'` — the full cumulative turn state, replayed the moment THIS client
 *     connects (first load / refresh / navigate-back / network blip). This is what lets a long response
 *     keep streaming after a reconnect: the producing turn runs server-side independent of the
 *     connection, so on reconnect we catch up to the current state instead of seeing nothing.
 *   - delta kinds (`text_delta`/`thinking`/`tool_use`/`tool_result`/…) — applied on top, live.
 *   - `turn_end` — handled in `thread-events.ts` (refetch `/messages`, then `endLiveTurn`).
 *
 * `seq` is a server-global monotonic counter. We keep the max applied `seq` per thread and ignore any
 * frame with `seq <= lastSeq`, so the snapshot-then-live merge (and any duplicate replay) is race-free.
 * Mirrors the external-store pattern in `thread-status.ts`.
 */

export type LiveBlock =
  // `parentToolUseId` (set only for SUBAGENT blocks) lets the live view peel a subagent's activity out of
  // the main turn into its own card / sub-page — mirrors the durable `meta.parentToolUseId`.
  | { kind: 'text'; key: string; text: string; done: boolean; parentToolUseId?: string }
  | { kind: 'thinking'; key: string; text: string; done: boolean; parentToolUseId?: string }
  | {
      kind: 'tool';
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
};

let blockSeq = 0;

/** The default lane — the thread brain's conversational turn (vs `phase:<stepId>` for a build turn). */
export const MAIN_LANE = 'main';
/** The store keys an in-flight turn by thread AND lane, so a brain turn and a build turn coexist. */
const laneKey = (jobId: string, lane: string): string => `${jobId}::${lane}`;

class ThreadStreamStore {
  /** key: `${jobId}::${lane}` → that lane's in-flight turn. */
  private map = new Map<string, LiveTurn>();
  /**
   * Per-key listeners. The repo SSE feeds frames for EVERY in-flight turn in the repo into this one store
   * (so switching to a sibling thread mid-stream is instant — its snapshot+deltas are already here). To
   * keep that cheap, a `useLiveTurn(jobId, lane)` subscriber re-renders ONLY when ITS key changes, not
   * on every other thread's token — so a busy sibling never churns the open conversation.
   */
  private readonly keyListeners = new Map<string, Set<() => void>>();

  /** Apply a `{type:'stream'}` frame's event (snapshot or delta) for a turn lane, deduped by `seq`. */
  apply(jobId: string, lane: string, seq: number, ev: StreamPayload | null | undefined): void {
    if (!jobId || !ev?.kind) return;
    const key = laneKey(jobId, lane);
    const cur = this.map.get(key);

    // Snapshot: the authoritative full state at `seq`. Replace, unless we already have newer deltas.
    if (ev.kind === 'snapshot') {
      if (cur && seq < cur.lastSeq) return;
      this.map.set(key, {
        blocks: (ev.blocks ?? []).map((b) => ({ ...b })),
        active: ev.active ?? true,
        lastSeq: seq,
      });
      this.notify(key);
      return;
    }

    // Deltas are ordered + monotonic; drop anything already reflected (e.g. covered by a snapshot).
    if (cur && seq <= cur.lastSeq) return;

    const blocks = cur ? [...cur.blocks] : [];
    const last = blocks[blocks.length - 1];
    const text = typeof ev.text === 'string' ? ev.text : '';
    // Only merge into the open block when it belongs to the SAME author (brain vs a given subagent), so a
    // subagent's forwarded text never appends onto the brain's open text block (or another subagent's).
    const pid = ev.parentToolUseId;
    const sameAuthor = (b: LiveBlock | undefined): boolean => !!b && b.parentToolUseId === pid;

    switch (ev.kind) {
      case 'text_delta':
        if (last && last.kind === 'text' && !last.done && sameAuthor(last))
          blocks[blocks.length - 1] = { ...last, text: last.text + text };
        else blocks.push({ kind: 'text', key: `c${blockSeq++}`, text, done: false, parentToolUseId: pid });
        break;
      case 'text':
        if (last && last.kind === 'text' && !last.done && sameAuthor(last))
          blocks[blocks.length - 1] = { ...last, text, done: true };
        else blocks.push({ kind: 'text', key: `c${blockSeq++}`, text, done: true, parentToolUseId: pid });
        break;
      case 'thinking_delta':
        if (last && last.kind === 'thinking' && !last.done && sameAuthor(last))
          blocks[blocks.length - 1] = { ...last, text: last.text + text };
        else blocks.push({ kind: 'thinking', key: `c${blockSeq++}`, text, done: false, parentToolUseId: pid });
        break;
      case 'thinking':
        if (last && last.kind === 'thinking' && !last.done && sameAuthor(last))
          blocks[blocks.length - 1] = { ...last, text, done: true };
        else blocks.push({ kind: 'thinking', key: `c${blockSeq++}`, text, done: true, parentToolUseId: pid });
        break;
      case 'tool_use':
        blocks.push({
          kind: 'tool',
          key: `c${blockSeq++}`,
          toolId: typeof ev.id === 'string' ? ev.id : '',
          name: typeof ev.name === 'string' ? ev.name : 'tool',
          input: ev.input,
          done: false,
          parentToolUseId: pid,
        });
        break;
      case 'tool_result': {
        const id = typeof ev.id === 'string' ? ev.id : '';
        for (let i = blocks.length - 1; i >= 0; i--) {
          const b = blocks[i];
          if (b.kind === 'tool' && !b.done && (b.toolId === id || id === '')) {
            blocks[i] = {
              ...b,
              result: ev.result,
              isError: Boolean(ev.isError),
              ...(ev.structuredPatch !== undefined ? { structuredPatch: ev.structuredPatch } : {}),
              done: true,
            };
            break;
          }
        }
        break;
      }
      default:
        // session / result — advance seq but don't change rendered blocks.
        this.map.set(key, { blocks, active: true, lastSeq: seq });
        this.notify(key);
        return;
    }

    this.map.set(key, { blocks, active: true, lastSeq: seq });
    this.notify(key);
  }

  end(jobId: string, lane: string): void {
    const key = laneKey(jobId, lane);
    if (!this.map.has(key)) return;
    this.map.delete(key);
    this.notify(key);
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
export function applyStreamFrame(jobId: string, lane: string, seq: number, event: unknown): void {
  store.apply(jobId, lane, seq, event as StreamPayload);
}

/** Clear a thread's live turn lane — call AFTER the durable `/messages` refetch lands (post `turn_end`). */
export function endLiveTurn(jobId: string, lane: string = MAIN_LANE): void {
  store.end(jobId, lane);
}

/**
 * Is the `main` (brain) turn currently streaming for this thread? Read OUTSIDE React (e.g. in a mutation's
 * `onMutate`) to decide whether a just-sent message is QUEUED behind a running turn — the brain serializes
 * turns per thread, so a follow-up sent mid-turn waits for the current one to finish. (Build/phase lanes
 * don't gate the brain's input, so this only consults the `main` lane.)
 */
export function isLiveTurnActive(jobId: string): boolean {
  return store.get(jobId, MAIN_LANE)?.active ?? false;
}

/**
 * Subscribe to one thread's in-flight live turn for a lane (default the brain's `main` turn). The
 * conversation reads `main`; a step sub-page reads its `phase:<stepId>` lane.
 */
export function useLiveTurn(jobId: string, lane: string = MAIN_LANE): LiveTurn | undefined {
  const key = laneKey(jobId, lane);
  const subscribe = useCallback((cb: () => void) => store.subscribeKey(key, cb), [key]);
  const getByKey = useCallback(() => store.getByKey(key), [key]);
  return useSyncExternalStore(subscribe, getByKey, () => undefined);
}
