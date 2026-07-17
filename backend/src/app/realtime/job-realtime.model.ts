import {
  type ModelConfig,
  RealtimeRuleGuard,
  type Row,
} from '@workspace/pg-realtime';
import type { JobHalt, JobStatus } from '@workspace/shared';
import {
  deriveNeedsYou,
  JOB_ACTIVITIES,
  type JobActivity,
  type JobProvenance,
} from '@shared/domain/job';
import type { CiCounts } from '../git';

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
  status: JobStatus;
  /** What the system is doing now ('idle'|'turn'|'plan_review'|'build'|'master_review') — any non-'idle'
   *  value suppresses the "needs you" dot while the system owns the next step. */
  activity: JobActivity;
  /** Unresolved turn-failure box outstanding — drives the sidebar ✕ glyph even when status is untouched. */
  halted: boolean;
  needsYou: boolean;
  createdAt: string;
  orgId: string;
  repoId: string;
  /** The canonical feature branch (host-named); null until assigned. UI shows it + drift vs currentBranch. */
  featureBranch: string | null;
  /** The branch the sandbox HEAD is actually on (sampled) — differs from featureBranch = drift. */
  currentBranch: string | null;
  /** Observed PR CI status ('success'|'failure'|'pending'|'skipped'|null) — reconciler-owned UI badge. */
  ciStatus: string | null;
  /** Per-category CI counts ({ failing, pending, passed, skipped, total }) — parallel to ciStatus; null when no checks. */
  ciCounts: CiCounts | null;
  /** Observed GitHub mergeable_state ('clean'|'dirty'|…|null) — 'dirty' drives the conflict badge. */
  prMergeable: string | null;
  /** Observed PR lifecycle ('open'|'merged'|'closed'|null) — drives the sidebar PR-status glyph. */
  prState: string | null;
  /** Tri-state sidebar port badge ('exposed'|'internal'|null) — precomputed by ExposureService.reconcile. */
  portState: string | null;
  /** Sidebar build-stage progress ('n of N' builder stages done) — precomputed by
   *  DriverStoreService.recomputeBuildStageProgress. Null = not applicable / never computed. */
  buildStagesDone: number | null;
  buildStagesTotal: number | null;
  /** Anchor map for sidebar within-section ordering (backend JobStatus -> first-entry ISO ts),
   *  maintained by the `jobs_stamp_section_entered` DB trigger. See job.entity.ts. */
  sectionFirstEntered: Partial<Record<JobStatus, string>> | null;
  /** True only while a "Ship it" is being finalized (PR opening). Shipping re-uses the `running` status,
   *  so this distinguishes "opening PR" from "building threads" and keeps the card in "Ready to Ship". */
  shipping: boolean;
  /** Null when healthy; when set, the sidebar renders a red halt overlay from it. */
  halt: JobHalt | null;
  /** Who spawned this job (immutable snapshot), or null for top-level jobs. */
  createdBy: JobProvenance | null;
}

/**
 * Row-level scope: a user may stream only threads belonging to an org they are a member of, AND only
 * non-`archived` threads. Membership is decided by ONE engine (mingo) on BOTH the snapshot and the live
 * matcher, so excluding `archived` here does double duty: an archived row never appears in the initial
 * snapshot, and — because archiving is a status UPDATE, not a row DELETE — the matcher sees the updated
 * row leave the result set (`!pass`) and emits a `remove` delta, dropping it from the active sidebar
 * live. The web console fetches archived jobs separately (`GET /web/jobs/archived`); it needs no client
 * filter — an archived job simply arrives as a `remove`.
 */
class ThreadOrgGuard extends RealtimeRuleGuard<
  RealtimePrincipal,
  ThreadRealtimeRow
> {
  canRead(
    user: RealtimePrincipal | null,
  ): { orgId: { $in: string[] }; status: { $ne: string } } | false {
    if (!user || user.orgIds.length === 0) return false;
    return { orgId: { $in: user.orgIds }, status: { $ne: 'archived' } };
  }
}

function mapRow(raw: Row): ThreadRealtimeRow {
  const status = String(raw.status) as JobStatus;
  // The WAL row values are `unknown`, so narrow `activity` to the union (unknown/bad → 'idle').
  const rawActivity = String(raw.activity ?? 'idle');
  const activity: JobActivity = (JOB_ACTIVITIES as readonly string[]).includes(
    rawActivity,
  )
    ? (rawActivity as JobActivity)
    : 'idle';
  // The durable human-input gate (see `deriveNeedsYou`): how many `ask_question` cards await the operator.
  // `SELECT *` snapshots and the WAL new-row image both carry this small (never-TOASTed) column, so it is
  // always present here; opening/answering a question updates the thread row → fires a realtime delta.
  const openQuestion = Number(raw.open_question_count ?? 0) > 0;
  // Durable/mcp secret requests are per-card (like questions), counted by `open_secret_count`; ephemeral
  // requests still use the single-slot `awaiting_secret_id` pointer. Either awaiting the operator counts.
  const awaitingSecret =
    raw.awaiting_secret_id != null || Number(raw.open_secret_count ?? 0) > 0;
  const halted = raw.halted === true;
  const createdAt = raw.created_at;
  return {
    jobId: String(raw.id),
    title: (raw.title as string | null) ?? null,
    origin: String(raw.origin),
    kind: (raw.kind as string | null) ?? null,
    status,
    activity,
    halted,
    needsYou: deriveNeedsYou({
      status,
      activity,
      openQuestion,
      awaitingSecret,
      halted: halted || raw.halt != null,
    }),
    createdAt:
      createdAt instanceof Date ? createdAt.toISOString() : String(createdAt),
    orgId: String(raw.org_id),
    repoId: String(raw.repo_id),
    featureBranch: (raw.feature_branch as string | null) ?? null,
    currentBranch: (raw.current_branch as string | null) ?? null,
    ciStatus: (raw.ci_status as string | null) ?? null,
    ciCounts: (raw.ci_counts as CiCounts | null) ?? null,
    prMergeable: (raw.pr_mergeable as string | null) ?? null,
    prState: (raw.pr_state as string | null) ?? null,
    portState: (raw.port_state as string | null) ?? null,
    buildStagesDone:
      raw.build_stages_done == null ? null : Number(raw.build_stages_done),
    buildStagesTotal:
      raw.build_stages_total == null ? null : Number(raw.build_stages_total),
    // Small timestamp col, always present in the `SELECT *` snapshot / WAL new-row image (never TOASTed).
    shipping: status === 'running' && raw.ship_review_approved_at != null,
    halt: (raw.halt as JobHalt | null) ?? null,
    createdBy: (raw.created_by as JobProvenance | null) ?? null,
    sectionFirstEntered:
      (raw.section_first_entered as Partial<Record<JobStatus, string>> | null) ??
      null,
  };
}

/** The single model the realtime engine serves: the `threads` table, scoped per-org, projected flat. */
export const THREADS_MODEL: ModelConfig<ThreadRealtimeRow> = {
  table: 'jobs',
  primaryKey: 'id',
  // `halt` is jsonb. On UPDATE, pgoutput may omit an unchanged TOASTed jsonb value; refetch so status-only
  // or activity deltas never accidentally map an existing halt to null in the sidebar cache.
  refetchOnUpdate: true,
  mapRow,
  guard: new ThreadOrgGuard(),
};
