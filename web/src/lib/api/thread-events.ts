'use client';

import { useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import { env } from '@/lib/env';
import { connectivity } from './connectivity';
import { qk } from './query-keys';
import { refreshSession } from './refresh';
import type { InboxThread } from './inbox';
import type { ThreadRef } from './thread-api';
import { applyStreamFrame, endLiveTurn } from './thread-stream';
import { clearQueuedSends } from './queued-sends';

/** A frame off the repo SSE: a durable-post change-signal, a live engine-stream frame, or a meta update. */
interface SseFrame {
  type?: string;
  threadId?: string;
  seq?: number;
  event?: { kind?: string };
  /** `thread_meta` frame: the new thread title (e.g. an auto-generated one). */
  title?: string;
}

/**
 * Live updates for the open thread. The repo-scoped SSE (`…/repos/:repoId/events`) carries two frame
 * types (discriminated by `type`):
 *
 *  - `{ type: 'message', … }` — a durable post landed (chat / approval card / PR / status). Used as a
 *    CHANGE-SIGNAL: debounced-refetch the open thread's messages + pipeline (the authoritative,
 *    threadId-scoped reads). A sibling thread's activity also triggers a refetch — fine for an operator
 *    console.
 *  - `{ type: 'stream', threadId, event }` — a LIVE engine-stream frame (token deltas, thinking, tool
 *    calls/results, and a `turn_end` marker) for the in-sandbox session. Filtered to the OPEN thread and
 *    fed into the live-turn store (`thread-stream.ts`); on `turn_end` we refetch `/messages` (now holding
 *    the persisted blocks) and THEN clear the live buffer (no flicker).
 *
 * `EventSource` self-heals transient drops; a FATAL close (401 on an expired cookie, which EventSource
 * never retries) triggers one session refresh + reconnect so the stream survives token rotation.
 */
export function useThreadEvents(ref: ThreadRef): void {
  const qc = useQueryClient();
  const { orgId, repoId, threadId } = ref;

  useEffect(() => {
    if (!orgId || !repoId || !threadId) return;
    const liveRef: ThreadRef = { orgId, repoId, threadId };
    let es: EventSource | null = null;
    let closed = false;
    let refreshedOnce = false;
    let debounce: ReturnType<typeof setTimeout> | null = null;

    const refetch = () => {
      if (debounce) clearTimeout(debounce);
      debounce = setTimeout(() => {
        void qc.invalidateQueries({ queryKey: qk.threadMessages(liveRef) });
        void qc.invalidateQueries({ queryKey: qk.threadPipeline(liveRef) });
      }, 250);
    };

    const reconcileNow = () =>
      Promise.all([
        qc.invalidateQueries({ queryKey: qk.threadMessages(liveRef) }),
        qc.invalidateQueries({ queryKey: qk.threadPipeline(liveRef) }),
      ]);

    const onFrame = (data: string) => {
      let frame: SseFrame | null = null;
      try {
        frame = JSON.parse(data) as SseFrame;
      } catch {
        refetch(); // unparseable → fall back to a change-signal refetch
        return;
      }
      if (frame?.type === 'stream') {
        if (frame.threadId !== threadId) return; // only the open thread's live turn
        if (frame.event?.kind === 'turn_end') {
          // Reconcile: refetch durable messages, THEN clear the live buffer (so no gap/flicker). The
          // blocking turn is done, so any messages queued behind it are no longer waiting — drop the
          // queued tags; their durable rows now settle into chronological order.
          void reconcileNow().then(() => {
            endLiveTurn(threadId);
            clearQueuedSends(threadId);
          });
        } else {
          // Snapshot (catch-up on connect) or a live delta — both deduped by seq in the store.
          applyStreamFrame(threadId, frame.seq ?? 0, frame.event);
        }
        return;
      }
      if (frame?.type === 'thread_meta' && frame.threadId && frame.title) {
        // A thread title changed (e.g. the auto-generated one). Patch the inbox cache in place — the
        // sidebar AND the navigator header both read the title from `allThreads` — then invalidate as a
        // backstop. (The navigator/sidebar update live; no message frame is involved in titling.)
        const { threadId: id, title } = frame;
        qc.setQueryData<InboxThread[]>(qk.allThreads(), (prev) =>
          prev?.map((t) => (t.id === id ? { ...t, title } : t)),
        );
        void qc.invalidateQueries({ queryKey: qk.allThreads() });
        return;
      }
      // `{ type: 'message' }` (or any non-stream frame) — a durable post landed → change-signal refetch.
      refetch();
    };

    const connect = () => {
      if (closed) return;
      es = new EventSource(`${env.NEXT_PUBLIC_HTTP_URL}/web/orgs/${orgId}/repos/${repoId}/events`, {
        withCredentials: true,
      });
      es.onopen = () => {
        refreshedOnce = false;
        connectivity.reportReachable();
        // Catch a title generated before this stream subscribed: pull the durable title from `allThreads`
        // (a `thread_meta` frame could have fired during the connect gap).
        void qc.invalidateQueries({ queryKey: qk.allThreads() });
      };
      es.onmessage = (e: MessageEvent) => {
        connectivity.reportReachable();
        onFrame(e.data as string);
      };
      es.onerror = () => {
        connectivity.reportUnreachable();
        if (!es || es.readyState !== EventSource.CLOSED || refreshedOnce) return;
        refreshedOnce = true;
        void refreshSession().then((ok) => {
          if (ok && !closed) {
            es?.close();
            connect();
          }
        });
      };
    };

    connect();
    return () => {
      closed = true;
      if (debounce) clearTimeout(debounce);
      es?.close();
    };
  }, [orgId, repoId, threadId, qc]);
}
