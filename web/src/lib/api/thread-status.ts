'use client';

import { useSyncExternalStore } from 'react';
import type { ThreadStatus } from './types';

/**
 * Cross-thread status seam — **PREPARED FOR REALTIME**.
 *
 * The cross-org inbox (`GET /web/threads`) carries no status / "needs you" signal, so the board, the org
 * rail, and the sidebar can't derive live status from the thread list alone. This tiny external store
 * holds whatever per-thread status we DO know and lets any shell component read it; components no-op
 * (render no dot/badge) for threads absent from the map, so the UI degrades gracefully with no data.
 *
 * TODAY it is fed only by the **open thread** — the workspace writes its real `/pipeline` status here via
 * `setThreadStatus`, so at least the active thread lights up across the shell. When a realtime status
 * feed lands (the user's planned next step), push into `setThreadStatus(threadId, …)` from that one
 * source and every dot/badge comes alive with no component changes.
 */
export interface ThreadStatusEntry {
  status: ThreadStatus;
  /** Your action unblocks it (awaiting your approval / your paused session / your triage). */
  needsYou: boolean;
}

const EMPTY: ReadonlyMap<string, ThreadStatusEntry> = new Map();

class ThreadStatusStore {
  private map = new Map<string, ThreadStatusEntry>();
  /** Cached immutable snapshot — a new identity on each change so `useSyncExternalStore` re-renders. */
  private snapshot: ReadonlyMap<string, ThreadStatusEntry> = EMPTY;
  private readonly listeners = new Set<() => void>();

  set(threadId: string, entry: ThreadStatusEntry | null): void {
    if (!threadId) return;
    const cur = this.map.get(threadId);
    if (entry === null) {
      if (!cur) return;
      this.map.delete(threadId);
    } else {
      if (cur && cur.status === entry.status && cur.needsYou === entry.needsYou) return;
      this.map.set(threadId, entry);
    }
    this.snapshot = new Map(this.map);
    this.listeners.forEach((l) => l());
  }

  subscribe = (cb: () => void): (() => void) => {
    this.listeners.add(cb);
    return () => {
      this.listeners.delete(cb);
    };
  };
  getSnapshot = (): ReadonlyMap<string, ThreadStatusEntry> => this.snapshot;
  getServerSnapshot = (): ReadonlyMap<string, ThreadStatusEntry> => EMPTY;
}

const store = new ThreadStatusStore();

/** The single wiring point — call from the workspace today, and from the realtime feed when it lands. */
export function setThreadStatus(threadId: string, entry: ThreadStatusEntry | null): void {
  store.set(threadId, entry);
}

/** Subscribe to the whole per-thread status map (board / rail iterate it). */
export function useThreadStatuses(): ReadonlyMap<string, ThreadStatusEntry> {
  return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getServerSnapshot);
}

/** Subscribe to one thread's status (a single row / card). */
export function useThreadStatus(threadId: string): ThreadStatusEntry | undefined {
  return useThreadStatuses().get(threadId);
}
