'use client';

import { useSyncExternalStore } from 'react';

/**
 * LIVE engine-stream store — the in-flight turn of a thread's in-sandbox Claude Code session, made
 * RESUMABLE.
 *
 * The repo SSE (`…/repos/:repoId/events`) carries `{ type:'stream', threadId, seq, event }` frames:
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
  /** set only for subagent blocks (the spawning Task id) — peeled into a sub-page by consumers. */
  parentToolUseId?: string;
  /** present on `kind:'snapshot'` */
  blocks?: LiveBlock[];
  active?: boolean;
};

const EMPTY: ReadonlyMap<string, LiveTurn> = new Map();
let blockSeq = 0;

/** The default lane — the thread brain's conversational turn (vs `phase:<stepId>` for a build turn). */
export const MAIN_LANE = 'main';
/** The store keys an in-flight turn by thread AND lane, so a brain turn and a build turn coexist. */
const laneKey = (threadId: string, lane: string): string => `${threadId}::${lane}`;

class ThreadStreamStore {
  /** key: `${threadId}::${lane}` → that lane's in-flight turn. */
  private map = new Map<string, LiveTurn>();
  private snapshot: ReadonlyMap<string, LiveTurn> = EMPTY;
  private readonly listeners = new Set<() => void>();

  /** Apply a `{type:'stream'}` frame's event (snapshot or delta) for a turn lane, deduped by `seq`. */
  apply(threadId: string, lane: string, seq: number, ev: StreamPayload | null | undefined): void {
    if (!threadId || !ev?.kind) return;
    const key = laneKey(threadId, lane);
    const cur = this.map.get(key);

    // Snapshot: the authoritative full state at `seq`. Replace, unless we already have newer deltas.
    if (ev.kind === 'snapshot') {
      if (cur && seq < cur.lastSeq) return;
      this.map.set(key, {
        blocks: (ev.blocks ?? []).map((b) => ({ ...b })),
        active: ev.active ?? true,
        lastSeq: seq,
      });
      this.bump();
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
            blocks[i] = { ...b, result: ev.result, isError: Boolean(ev.isError), done: true };
            break;
          }
        }
        break;
      }
      default:
        // session / result — advance seq but don't change rendered blocks.
        this.map.set(key, { blocks, active: true, lastSeq: seq });
        this.bump();
        return;
    }

    this.map.set(key, { blocks, active: true, lastSeq: seq });
    this.bump();
  }

  end(threadId: string, lane: string): void {
    const key = laneKey(threadId, lane);
    if (!this.map.has(key)) return;
    this.map.delete(key);
    this.bump();
  }

  get(threadId: string, lane: string): LiveTurn | undefined {
    return this.snapshot.get(laneKey(threadId, lane));
  }

  private bump(): void {
    this.snapshot = new Map(this.map);
    this.listeners.forEach((l) => l());
  }

  subscribe = (cb: () => void): (() => void) => {
    this.listeners.add(cb);
    return () => {
      this.listeners.delete(cb);
    };
  };
  getSnapshot = (): ReadonlyMap<string, LiveTurn> => this.snapshot;
  getServerSnapshot = (): ReadonlyMap<string, LiveTurn> => EMPTY;
}

const store = new ThreadStreamStore();

/** Feed one `{type:'stream'}` frame (snapshot or delta) into a thread's live turn lane. */
export function applyStreamFrame(threadId: string, lane: string, seq: number, event: unknown): void {
  store.apply(threadId, lane, seq, event as StreamPayload);
}

/** Clear a thread's live turn lane — call AFTER the durable `/messages` refetch lands (post `turn_end`). */
export function endLiveTurn(threadId: string, lane: string = MAIN_LANE): void {
  store.end(threadId, lane);
}

/**
 * Is the `main` (brain) turn currently streaming for this thread? Read OUTSIDE React (e.g. in a mutation's
 * `onMutate`) to decide whether a just-sent message is QUEUED behind a running turn — the brain serializes
 * turns per thread, so a follow-up sent mid-turn waits for the current one to finish. (Build/phase lanes
 * don't gate the brain's input, so this only consults the `main` lane.)
 */
export function isLiveTurnActive(threadId: string): boolean {
  return store.get(threadId, MAIN_LANE)?.active ?? false;
}

/**
 * Subscribe to one thread's in-flight live turn for a lane (default the brain's `main` turn). The
 * conversation reads `main`; a step sub-page reads its `phase:<stepId>` lane.
 */
export function useLiveTurn(threadId: string, lane: string = MAIN_LANE): LiveTurn | undefined {
  return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getServerSnapshot).get(
    laneKey(threadId, lane),
  );
}
