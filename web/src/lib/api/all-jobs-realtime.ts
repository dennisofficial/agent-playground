"use client";

import { useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { env } from "@/lib/env";
import { qk } from "./query-keys";
import { subscribeSse, type SseHandle } from "./sse-manager";
import { uiStatus, type InboxThread } from "./inbox";
import { toJobKind } from "./status";
import type { WireJobKind, WireJobHalt, PrState, CiStatus } from "./types";

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
  /** An unresolved turn-failure box is outstanding — drives the sidebar failed-style ✕ glyph. */
  halted: boolean;
  orgId: string;
  repoId: string;
  /** The OBSERVED live branch — a change (agent `git checkout`) invalidates the open thread's pipeline so
   *  the navigator drift badge goes live even without a status flip. */
  currentBranch?: string | null;
  /** Observed PR lifecycle ('open'|'merged'|'closed'|null) — drives the PR-status glyph. */
  prState?: string | null;
  /** GitHub mergeable_state ('dirty' = conflict); refines the open-PR glyph. */
  prMergeable?: string | null;
  /** Aggregate CI outcome for the PR head (`jobs.ci_status`) — WAL row is loosely typed like prState. */
  ciStatus?: string | null;
  /** Failure/pause axis, orthogonal to `status` (the build phase) — null when healthy. */
  halt?: WireJobHalt | null;
}

/** A pg-realtime delta (mirrors the backend `RowDelta`), plus the `disabled` control frame. */
type RowDelta =
  | { kind: "data"; rows: Array<{ pk: string; row: RealtimeRow }> }
  | { kind: "add"; pk: string; row: RealtimeRow }
  | { kind: "update"; pk: string; row: RealtimeRow }
  | { kind: "remove"; pk: string }
  // Sent by the backend when realtime is unavailable — we close and rely on polling (no reconnect storm).
  | { kind: "disabled" };

function sameHalt(
  a: WireJobHalt | null,
  b: WireJobHalt | null,
): boolean {
  return a?.kind === b?.kind && a?.reason === b?.reason && a?.at === b?.at;
}

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
    const invalidate = () =>
      void qc.invalidateQueries({ queryKey: qk.allJobs() });

    // Per-job last-seen observed branch — lets us detect a live `git checkout` (a `current_branch` write
    // fires a WAL update with no status flip) and refresh the open thread's pipeline for the drift badge.
    const lastBranchByJob = new Map<string, string | null>();

    const patchUpdate = (row: RealtimeRow) => {
      let found = false;
      let statusChanged = false;
      let haltChanged = false;
      let prChanged = false;
      let ciChanged = false;
      const nextStatus = uiStatus(row.status, row.origin);
      const nextBranch = row.currentBranch ?? null;
      const prevBranch = lastBranchByJob.get(row.jobId);
      const branchChanged = prevBranch !== undefined && prevBranch !== nextBranch;
      lastBranchByJob.set(row.jobId, nextBranch);
      const nextPrState = row.prState ?? null;
      const nextPrMergeable = row.prMergeable ?? null;
      const nextCi = (row.ciStatus ?? null) as CiStatus | null;
      const nextHalt = "halt" in row ? (row.halt ?? null) : undefined;
      qc.setQueryData<InboxThread[]>(qk.allJobs(), (prev) => {
        if (!prev) return prev;
        const idx = prev.findIndex((t) => t.id === row.jobId);
        if (idx === -1) return prev;
        found = true;
        statusChanged = prev[idx].status !== nextStatus;
        // A PR-state or mergeable transition (e.g. a GitHub merge) moves only these fields — `status`
        // was already latched to `done` when the PR opened — so it must trigger its own detail refresh.
        prChanged =
          (prev[idx].pr?.state ?? null) !== nextPrState ||
          (prev[idx].pr?.mergeable ?? null) !== nextPrMergeable;
        ciChanged = (prev[idx].ci ?? null) !== nextCi;
        const halt = nextHalt === undefined ? prev[idx].halt : nextHalt;
        haltChanged = !sameHalt(prev[idx].halt, halt);
        const next = [...prev];
        next[idx] = {
          ...next[idx],
          title: row.title?.trim() || next[idx].title,
          kind: row.kind ? toJobKind(row.kind as WireJobKind) : next[idx].kind,
          status: nextStatus,
          needsYou: row.needsYou,
          halted: row.halted,
          // The flat WAL row carries no PR url — preserve the enriched one from the fetched row so a
          // live conflict→ready→merged transition re-glyphs without dropping the click-through link.
          pr: row.prState
            ? {
                state: row.prState as PrState,
                // The number and url are stable once a PR exists and the flat WAL row omits them —
                // preserve the enriched values so a live state transition re-glyphs without dropping them.
                number: next[idx].pr?.number ?? null,
                mergeable: row.prMergeable ?? null,
                url: next[idx].pr?.url ?? null,
              }
            : null,
          ci: nextCi,
          halt,
        };
        return next;
      });
      if (!found) {
        invalidate(); // a thread we don't have cached yet → refetch the enriched list
        return;
      }
      // A status transition (e.g. approve → running, → building, cancelled), branch switch, HALT change, or
      // PR-state change means the OPEN thread's detail pane is stale. Halt is intentionally orthogonal to
      // status, so without the explicit haltChanged gate a failed/paused build could update the sidebar but
      // leave the workspace banner and pipeline tree stale until a later refetch. A GitHub-originated PR merge
      // moves only pr_state (status already latched to `done` when the PR opened), so it needs its own gate.
      if (statusChanged || branchChanged || haltChanged || prChanged || ciChanged) {
        const ref = { orgId: row.orgId, repoId: row.repoId, jobId: row.jobId };
        // The pipeline carries the branch fields the drift badge reads AND the PR state the workspace badge
        // reads — refresh on a status flip, a live branch switch, or a PR-state/mergeable transition.
        void qc.invalidateQueries({ queryKey: qk.threadPipeline(ref) });
        // Halt writes also append a durable operator message; the PR-sync path does not, so PR changes alone
        // don't refresh messages.
        if (statusChanged || haltChanged) {
          void qc.invalidateQueries({ queryKey: qk.threadMessages(ref) });
        }
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
      if (delta.kind === "disabled") {
        // Realtime is off on the server — stop this stream for good (no reconnect storm) and let the
        // query's normal polling keep the dots fresh.
        handle.closePermanently();
        return;
      }
      if (delta.kind === "update") patchUpdate(delta.row);
      else invalidate(); // snapshot / add / remove → refetch the enriched list
    };

    return subscribeSse(`${env.NEXT_PUBLIC_HTTP_URL}/web/jobs/realtime`, {
      onFrame,
    });
  }, [qc]);
}
