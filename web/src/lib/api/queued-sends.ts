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
 * Lifecycle: added in `useSay` when `isLiveTurnActive(jobId)`; cleared on the blocking turn's
 * `turn_end` (in `thread-events.ts`), at which point the queued message's own turn begins and its durable
 * row settles into chronological order. Matching is by text — adequate for the operator console (a rare
 * duplicate-text edge just clears one entry early).
 */

const EMPTY: ReadonlySet<string> = new Set();

class QueuedSendsStore {
  private map = new Map<string, Set<string>>();
  private snapshots = new Map<string, ReadonlySet<string>>();
  private readonly listeners = new Set<() => void>();

  add(jobId: string, text: string): void {
    if (!jobId || !text) return;
    let set = this.map.get(jobId);
    if (!set) {
      set = new Set();
      this.map.set(jobId, set);
    }
    set.add(text);
    this.refresh(jobId);
  }

  clear(jobId: string): void {
    if (!this.map.has(jobId)) return;
    this.map.delete(jobId);
    this.refresh(jobId);
  }

  get(jobId: string): ReadonlySet<string> {
    return this.snapshots.get(jobId) ?? EMPTY;
  }

  private refresh(jobId: string): void {
    const set = this.map.get(jobId);
    this.snapshots.set(jobId, set ? new Set(set) : EMPTY);
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
export function addQueuedSend(jobId: string, text: string): void {
  store.add(jobId, text);
}

/** Clear a thread's queued sends — call after the blocking turn ends + the durable refetch lands. */
export function clearQueuedSends(jobId: string): void {
  store.clear(jobId);
}

/** Subscribe to the set of queued send texts for a thread (the conversation marks matching bubbles). */
export function useQueuedSends(jobId: string): ReadonlySet<string> {
  return useSyncExternalStore(
    store.subscribe,
    () => store.get(jobId),
    () => EMPTY,
  );
}
