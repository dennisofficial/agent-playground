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
  | { kind: 'text'; key: string; text: string; done: boolean }
  | { kind: 'thinking'; key: string; text: string; done: boolean }
  | {
      kind: 'tool';
      key: string;
      toolId?: string;
      name: string;
      input?: unknown;
      result?: unknown;
      isError?: boolean;
      done: boolean;
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
  /** present on `kind:'snapshot'` */
  blocks?: LiveBlock[];
  active?: boolean;
};

const EMPTY: ReadonlyMap<string, LiveTurn> = new Map();
let blockSeq = 0;

class ThreadStreamStore {
  private map = new Map<string, LiveTurn>();
  private snapshot: ReadonlyMap<string, LiveTurn> = EMPTY;
  private readonly listeners = new Set<() => void>();

  /** Apply a `{type:'stream'}` frame's event (snapshot or delta) for a thread, deduped by `seq`. */
  apply(threadId: string, seq: number, ev: StreamPayload | null | undefined): void {
    if (!threadId || !ev?.kind) return;
    const cur = this.map.get(threadId);

    // Snapshot: the authoritative full state at `seq`. Replace, unless we already have newer deltas.
    if (ev.kind === 'snapshot') {
      if (cur && seq < cur.lastSeq) return;
      this.map.set(threadId, {
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

    switch (ev.kind) {
      case 'text_delta':
        if (last && last.kind === 'text' && !last.done)
          blocks[blocks.length - 1] = { ...last, text: last.text + text };
        else blocks.push({ kind: 'text', key: `c${blockSeq++}`, text, done: false });
        break;
      case 'text':
        if (last && last.kind === 'text' && !last.done)
          blocks[blocks.length - 1] = { ...last, text, done: true };
        else blocks.push({ kind: 'text', key: `c${blockSeq++}`, text, done: true });
        break;
      case 'thinking_delta':
        if (last && last.kind === 'thinking' && !last.done)
          blocks[blocks.length - 1] = { ...last, text: last.text + text };
        else blocks.push({ kind: 'thinking', key: `c${blockSeq++}`, text, done: false });
        break;
      case 'thinking':
        if (last && last.kind === 'thinking' && !last.done)
          blocks[blocks.length - 1] = { ...last, text, done: true };
        else blocks.push({ kind: 'thinking', key: `c${blockSeq++}`, text, done: true });
        break;
      case 'tool_use':
        blocks.push({
          kind: 'tool',
          key: `c${blockSeq++}`,
          toolId: typeof ev.id === 'string' ? ev.id : '',
          name: typeof ev.name === 'string' ? ev.name : 'tool',
          input: ev.input,
          done: false,
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
        this.map.set(threadId, { blocks, active: true, lastSeq: seq });
        this.bump();
        return;
    }

    this.map.set(threadId, { blocks, active: true, lastSeq: seq });
    this.bump();
  }

  end(threadId: string): void {
    if (!this.map.has(threadId)) return;
    this.map.delete(threadId);
    this.bump();
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

/** Feed one `{type:'stream'}` frame (snapshot or delta) into the thread's live turn. */
export function applyStreamFrame(threadId: string, seq: number, event: unknown): void {
  store.apply(threadId, seq, event as StreamPayload);
}

/** Clear a thread's live turn — call AFTER the durable `/messages` refetch lands (post `turn_end`). */
export function endLiveTurn(threadId: string): void {
  store.end(threadId);
}

/** Subscribe to one thread's in-flight live turn (the conversation renders it below durable messages). */
export function useLiveTurn(threadId: string): LiveTurn | undefined {
  return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getServerSnapshot).get(threadId);
}
