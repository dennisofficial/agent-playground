'use client';

import { useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import { env } from '@/lib/env';
import { qk } from './query-keys';
import { subscribeSse, type SseHandle } from './sse-manager';
import { uiStatus, type InboxThread } from './inbox';
import { toJobKind } from './status';
import type { WireJobKind, PrState } from './types';

/**
 * The flat realtime `threads` row pushed by the backend engine (`GET /web/jobs/realtime`). Mirrors the
 * backend `ThreadRealtimeRow` — it carries the server-owned status signal but NOT the joined org/repo
 * display names, so an `update` patches those fields onto the already-enriched cached row, and an
 * `add`/`remove`/snapshot refetches the enriched list instead. `orgId`/`repoId` ARE present (the guard
 * scopes on them) — used to key the open thread's detail-pane queries when a status transition arrives.
 */
interface RealtimeRow {
  jobId: string;
  title: string | null;
  origin: string;
  /** Job build kind; null until scoped. Preferred over origin for the badge when present. */
  kind?: string | null;
  status: string;
  needsYou: boolean;
  orgId: string;
  repoId: string;
  /** Observed PR lifecycle ('open'|'merged'|'closed'|null) — drives the PR-status glyph. */
  prState?: string | null;
  /** GitHub mergeable_state ('dirty' = conflict); refines the open-PR glyph. */
  prMergeable?: string | null;
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
 * Resilience (transient self-heal + the refresh/reconnect retry loop) lives in the shared `sse-manager`.
 */
export function useAllJobsRealtime(): void {
  const qc = useQueryClient();

  useEffect(() => {
    const invalidate = () => void qc.invalidateQueries({ queryKey: qk.allJobs() });

    const patchUpdate = (row: RealtimeRow) => {
      let found = false;
      let statusChanged = false;
      const nextStatus = uiStatus(row.status, row.origin);
      qc.setQueryData<InboxThread[]>(qk.allJobs(), (prev) => {
        if (!prev) return prev;
        const idx = prev.findIndex((t) => t.id === row.jobId);
        if (idx === -1) return prev;
        found = true;
        statusChanged = prev[idx].status !== nextStatus;
        const next = [...prev];
        next[idx] = {
          ...next[idx],
          title: row.title?.trim() || next[idx].title,
          kind: row.kind ? toJobKind(row.kind as WireJobKind) : next[idx].kind,
          status: nextStatus,
          needsYou: row.needsYou,
          // The flat WAL row carries no PR url — preserve the enriched one from the fetched row so a
          // live conflict→ready→merged transition re-glyphs without dropping the click-through link.
          pr: row.prState
            ? { state: row.prState as PrState, mergeable: row.prMergeable ?? null, url: next[idx].pr?.url ?? null }
            : null,
        };
        return next;
      });
      if (!found) {
        invalidate(); // a thread we don't have cached yet → refetch the enriched list
        return;
      }
      // A status transition (e.g. approve → running, → building, cancelled) means the OPEN thread's
      // detail pane is stale: the WAL row updates the sidebar in place above, but the pipeline/message
      // queries are keyed per-thread and only THIS stream carries the (race-free, commit-driven) signal
      // that they changed. Invalidate them so an open thread's approve bar / phase states go live too;
      // for any non-open thread these are unobserved queries, so this just marks them stale (no fetch).
      if (statusChanged) {
        const ref = { orgId: row.orgId, repoId: row.repoId, jobId: row.jobId };
        void qc.invalidateQueries({ queryKey: qk.threadPipeline(ref) });
        void qc.invalidateQueries({ queryKey: qk.threadMessages(ref) });
      }
    };

    const onFrame = (data: string, handle: SseHandle) => {
      let delta: RowDelta | null = null;
      try {
        delta = JSON.parse(data) as RowDelta;
      } catch {
        return;
      }
      if (!delta) return;
      if (delta.kind === 'disabled') {
        // Realtime is off on the server — stop this stream for good (no reconnect storm) and let the
        // query's normal polling keep the dots fresh.
        handle.closePermanently();
        return;
      }
      if (delta.kind === 'update') patchUpdate(delta.row);
      else invalidate(); // snapshot / add / remove → refetch the enriched list
    };

    return subscribeSse(`${env.NEXT_PUBLIC_HTTP_URL}/web/jobs/realtime`, { onFrame });
  }, [qc]);
}
