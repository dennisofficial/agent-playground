'use client';

import { useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import { env } from '@/lib/env';
import { connectivity } from './connectivity';
import { qk } from './query-keys';
import { refreshSession } from './refresh';
import { uiStatus, type InboxThread } from './inbox';

/**
 * The flat realtime `threads` row pushed by the backend engine (`GET /web/threads/realtime`). Mirrors the
 * backend `ThreadRealtimeRow` — it carries the server-owned status signal but NOT the joined org/repo
 * display names, so an `update` patches those fields onto the already-enriched cached row, and an
 * `add`/`remove`/snapshot refetches the enriched list instead.
 */
interface RealtimeRow {
  threadId: string;
  title: string | null;
  origin: string;
  status: string;
  needsYou: boolean;
}

/** A pg-realtime delta (mirrors the backend `RowDelta`), plus the `disabled` control frame. */
type RowDelta =
  | { kind: 'data'; rows: Array<{ pk: string; row: RealtimeRow }> }
  | { kind: 'add'; pk: string; row: RealtimeRow }
  | { kind: 'update'; pk: string; row: RealtimeRow }
  | { kind: 'remove'; pk: string }
  // Sent by the backend when realtime is unavailable — we close and rely on polling (no reconnect storm).
  | { kind: 'disabled' };

/**
 * ONE cross-org realtime subscription for the whole shell — mounted once (in `AppChrome`), not per open
 * thread. Keeps every sidebar "needs you" dot + status pie live: an `update` (the latency-sensitive case,
 * e.g. a status flip or a turn starting/ending) patches the `all-threads` cache in place with no refetch;
 * a snapshot / `add` / `remove` (rarer, and needing the enriched org/repo names) invalidates the list so
 * it refetches. If realtime is unavailable (engine off / `wal_level` not logical) the stream errors and we
 * fall back to the query's normal polling — the dots stay correct on refetch, just not instant.
 *
 * Resilience mirrors `thread-events.ts`: `EventSource` self-heals transient drops; a FATAL close (a 401
 * on an expired cookie, which `EventSource` never retries) triggers one session refresh + reconnect.
 */
export function useAllThreadsRealtime(): void {
  const qc = useQueryClient();

  useEffect(() => {
    let es: EventSource | null = null;
    let closed = false;
    let refreshedOnce = false;

    const invalidate = () => void qc.invalidateQueries({ queryKey: qk.allThreads() });

    const patchUpdate = (row: RealtimeRow) => {
      let found = false;
      qc.setQueryData<InboxThread[]>(qk.allThreads(), (prev) => {
        if (!prev) return prev;
        const idx = prev.findIndex((t) => t.id === row.threadId);
        if (idx === -1) return prev;
        found = true;
        const next = [...prev];
        next[idx] = {
          ...next[idx],
          title: row.title?.trim() || next[idx].title,
          status: uiStatus(row.status, row.origin),
          needsYou: row.needsYou,
        };
        return next;
      });
      if (!found) invalidate(); // a thread we don't have cached yet → refetch the enriched list
    };

    const onFrame = (data: string) => {
      let delta: RowDelta | null = null;
      try {
        delta = JSON.parse(data) as RowDelta;
      } catch {
        return;
      }
      if (!delta) return;
      if (delta.kind === 'disabled') {
        // Realtime is off on the server — stop for good and let the query's polling keep dots fresh.
        closed = true;
        es?.close();
        return;
      }
      if (delta.kind === 'update') patchUpdate(delta.row);
      else invalidate(); // snapshot / add / remove → refetch the enriched list
    };

    const connect = () => {
      if (closed) return;
      es = new EventSource(`${env.NEXT_PUBLIC_HTTP_URL}/web/threads/realtime`, {
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
        // Let EventSource self-heal transient drops (readyState CONNECTING). Only act on a FATAL close,
        // and only once — a refresh+reconnect for an expired cookie. When realtime is simply unavailable
        // this bounds us to a couple of attempts, then we rely on the query's polling refetch.
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
      es?.close();
    };
  }, [qc]);
}
