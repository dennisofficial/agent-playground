import {
  type ModelConfig,
  RealtimeRuleGuard,
  type Row,
} from '@workspace/pg-realtime';
import type { JobHalt } from '@workspace/shared';
import { deriveNeedsYou } from '../domain/job';

/**
 * The authenticated principal handed to the realtime guard — resolved by the SSE endpoint from the
 * cookie session (the user + the orgs they belong to). The guard scopes every streamed row to these
 * orgs, so a subscription can only ever see threads in the caller's own organizations.
 */
export interface RealtimePrincipal {
  userId: string;
  orgIds: string[];
}

/**
 * The realtime `threads` row pushed to the web sidebar. A FLAT projection of the `threads` table (the
 * WAL gives us one row, no joins) — it carries `orgId`/`repoId` (the frontend already knows the org/repo
 * display names from its own caches) plus the server-owned status signal. `needsYou` is derived by the
 * SAME `deriveNeedsYou` the REST list uses, so the live row and the fetched row always agree.
 *
 * NOTE: mingo matches the guard scope against THIS mapped shape (not the raw row), so `orgId` MUST be
 * present here for `ThreadOrgGuard` to scope by it.
 */
export interface ThreadRealtimeRow extends Row {
  jobId: string;
  title: string | null;
  origin: string;
  /** Job kind ('feature'|'bugfix'|'onboarding'|'event'|'review'|null) — small text col, always in SELECT */
  kind: string | null;
  status: string;
  turnActive: boolean;
  /** Unresolved turn-failure box outstanding — drives the sidebar ✕ glyph even when status is untouched. */
  halted: boolean;
  /** A Codex plan review is in flight — suppresses the "needs you" dot while the system owns the next step. */
  reviewRunning: boolean;
  needsYou: boolean;
  createdAt: string;
  orgId: string;
  repoId: string;
  /** The canonical feature branch (host-named); null until assigned. UI shows it + drift vs currentBranch. */
  featureBranch: string | null;
  /** The branch the sandbox HEAD is actually on (sampled) — differs from featureBranch = drift. */
  currentBranch: string | null;
  /** Observed PR CI status ('success'|'failure'|'pending'|null) — reconciler-owned UI badge. */
  ciStatus: string | null;
  /** Observed GitHub mergeable_state ('clean'|'dirty'|…|null) — 'dirty' drives the conflict badge. */
  prMergeable: string | null;
  /** Observed PR lifecycle ('open'|'merged'|'closed'|null) — drives the sidebar PR-status glyph. */
  prState: string | null;
  /** Null when healthy; when set, the sidebar renders a red halt overlay from it. */
  halt: JobHalt | null;
}

/** Row-level scope: a user may stream only threads belonging to an org they are a member of. */
class ThreadOrgGuard extends RealtimeRuleGuard<
  RealtimePrincipal,
  ThreadRealtimeRow
> {
  canRead(
    user: RealtimePrincipal | null,
  ): { orgId: { $in: string[] } } | false {
    if (!user || user.orgIds.length === 0) return false;
    return { orgId: { $in: user.orgIds } };
  }
}

function mapRow(raw: Row): ThreadRealtimeRow {
  const status = String(raw.status);
  const turnActive = raw.turn_active === true;
  // The durable human-input gate (see `deriveNeedsYou`): how many `ask_question` cards await the operator.
  // `SELECT *` snapshots and the WAL new-row image both carry this small (never-TOASTed) column, so it is
  // always present here; opening/answering a question updates the thread row → fires a realtime delta.
  const awaitingQuestion = Number(raw.open_question_count ?? 0) > 0;
  const halted = raw.halted === true;
  // Denormalized mirror of the job's running `codex_reviews` row (a jobs-table column, so the single-table
  // WAL image carries it here — the mapper cannot query `codex_reviews`). Suppresses the dot mid-review.
  const reviewRunning = raw.review_running === true;
  const createdAt = raw.created_at;
  return {
    jobId: String(raw.id),
    title: (raw.title as string | null) ?? null,
    origin: String(raw.origin),
    kind: (raw.kind as string | null) ?? null,
    status,
    turnActive,
    halted,
    reviewRunning,
    needsYou: deriveNeedsYou(
      status,
      turnActive,
      awaitingQuestion,
      halted || raw.halt != null,
      reviewRunning,
    ),
    createdAt:
      createdAt instanceof Date ? createdAt.toISOString() : String(createdAt),
    orgId: String(raw.org_id),
    repoId: String(raw.repo_id),
    featureBranch: (raw.feature_branch as string | null) ?? null,
    currentBranch: (raw.current_branch as string | null) ?? null,
    ciStatus: (raw.ci_status as string | null) ?? null,
    prMergeable: (raw.pr_mergeable as string | null) ?? null,
    prState: (raw.pr_state as string | null) ?? null,
    halt: (raw.halt as JobHalt | null) ?? null,
  };
}

/** The single model the realtime engine serves: the `threads` table, scoped per-org, projected flat. */
export const THREADS_MODEL: ModelConfig<ThreadRealtimeRow> = {
  table: 'jobs',
  primaryKey: 'id',
  // `halt` is jsonb. On UPDATE, pgoutput may omit an unchanged TOASTed jsonb value; refetch so status-only
  // or turn-active deltas never accidentally map an existing halt to null in the sidebar cache.
  refetchOnUpdate: true,
  mapRow,
  guard: new ThreadOrgGuard(),
};
