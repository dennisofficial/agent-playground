'use client';

import { useSyncExternalStore } from 'react';

/**
 * QUEUED-SENDS store — the operator's follow-ups that were sent WHILE a turn was still streaming.
 *
 * The brain serializes turns per thread: a message sent mid-turn waits for the running turn to finish.
 * Without a relay it would just drop into the log as if already handled. This client-only store tracks
 * the text of such sends so the conversation can mark them "queued · sends when the current turn
 * finishes" and render them below the live response — distinct from a normal message.
 *
 * Lifecycle: added in `useSay` when `isLiveTurnActive(threadId)`; cleared on the blocking turn's
 * `turn_end` (in `thread-events.ts`), at which point the queued message's own turn begins and its durable
 * row settles into chronological order. Matching is by text — adequate for the operator console (a rare
 * duplicate-text edge just clears one entry early).
 */

const EMPTY: ReadonlySet<string> = new Set();

class QueuedSendsStore {
  private map = new Map<string, Set<string>>();
  private snapshots = new Map<string, ReadonlySet<string>>();
  private readonly listeners = new Set<() => void>();

  add(threadId: string, text: string): void {
    if (!threadId || !text) return;
    let set = this.map.get(threadId);
    if (!set) {
      set = new Set();
      this.map.set(threadId, set);
    }
    set.add(text);
    this.refresh(threadId);
  }

  clear(threadId: string): void {
    if (!this.map.has(threadId)) return;
    this.map.delete(threadId);
    this.refresh(threadId);
  }

  get(threadId: string): ReadonlySet<string> {
    return this.snapshots.get(threadId) ?? EMPTY;
  }

  private refresh(threadId: string): void {
    const set = this.map.get(threadId);
    this.snapshots.set(threadId, set ? new Set(set) : EMPTY);
    this.listeners.forEach((l) => l());
  }

  subscribe = (cb: () => void): (() => void) => {
    this.listeners.add(cb);
    return () => {
      this.listeners.delete(cb);
    };
  };
}

const store = new QueuedSendsStore();

/** Mark a just-sent message as queued behind the thread's running turn. */
export function addQueuedSend(threadId: string, text: string): void {
  store.add(threadId, text);
}

/** Clear a thread's queued sends — call after the blocking turn ends + the durable refetch lands. */
export function clearQueuedSends(threadId: string): void {
  store.clear(threadId);
}

/** Subscribe to the set of queued send texts for a thread (the conversation marks matching bubbles). */
export function useQueuedSends(threadId: string): ReadonlySet<string> {
  return useSyncExternalStore(
    store.subscribe,
    () => store.get(threadId),
    () => EMPTY,
  );
}
