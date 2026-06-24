'use client';

import { useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import { env } from '@/lib/env';
import { connectivity } from './connectivity';
import { qk } from './query-keys';
import { refreshSession } from './refresh';
import type { ThreadRef } from './thread-api';

/**
 * Live updates for the open thread. The SSE stream is **repo-scoped** (`…/repos/:repoId/events`) and
 * each frame is keyed by the repo + a surface `threadTs`, NOT the thread UUID — so we can't reliably
 * filter frames to this one thread. Instead we use SSE purely as a CHANGE-SIGNAL: on any frame for the
 * repo, debounced-refetch the open thread's messages + pipeline (the authoritative, threadId-scoped
 * reads). The cost is a small over-fetch (a sibling thread's activity also triggers a refetch), which is
 * fine for an operator console; see `web/BACKEND_GAPS.md`.
 *
 * `EventSource` self-heals transient drops; a FATAL close (401 on an expired cookie, which EventSource
 * never retries) triggers one session refresh + reconnect so the stream survives token rotation —
 * pattern lifted from the old channel `events.ts`.
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

    const connect = () => {
      if (closed) return;
      es = new EventSource(`${env.NEXT_PUBLIC_HTTP_URL}/web/orgs/${orgId}/repos/${repoId}/events`, {
        withCredentials: true,
      });
      es.onopen = () => {
        refreshedOnce = false;
        connectivity.reportReachable();
      };
      es.onmessage = () => {
        connectivity.reportReachable();
        refetch();
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
