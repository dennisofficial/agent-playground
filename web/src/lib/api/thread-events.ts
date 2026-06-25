'use client';

import { useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import { env } from '@/lib/env';
import { connectivity } from './connectivity';
import { qk } from './query-keys';
import { refreshSession } from './refresh';
import type { ThreadRef } from './thread-api';
import { applyStreamFrame, endLiveTurn } from './thread-stream';

/** A frame off the repo SSE: a durable-post change-signal, or a live engine-stream frame. */
interface SseFrame {
  type?: string;
  threadId?: string;
  seq?: number;
  event?: { kind?: string };
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
          // Reconcile: refetch durable messages, THEN clear the live buffer (so no gap/flicker).
          void reconcileNow().then(() => endLiveTurn(threadId));
        } else {
          // Snapshot (catch-up on connect) or a live delta — both deduped by seq in the store.
          applyStreamFrame(threadId, frame.seq ?? 0, frame.event);
        }
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
