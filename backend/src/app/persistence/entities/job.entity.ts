import {
  Column,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import type { AutoApproveMode } from '@workspace/shared';
import { TimestampedEntity } from '@workspace/shared/schemas';
import type { Decision } from '@shared/domain/decision-record';
import type { JobProvenance } from '@shared/domain/job';
import type { CiCounts } from '../../git';
import { DecisionRecordEntity } from './decision-record.entity';
import { OrganizationEntity } from './organization.entity';
import { RepoEntity } from './repo.entity';
import { ThreadEntity } from './thread.entity';
import { UserEntity } from './user.entity';

/**
 * A THREAD — the unit of work. One intent (a feature or a bugfix) = one sandbox = one worktree = one
 * feature branch = ONE PR. A thread may stay a plain conversation (`status='open'`) or enter the build
 * lifecycle; when it builds, the `threads`/`steps` rows hang directly off it (the former `jobs` layer
 * is folded in here). `decision_records` (1:many — the draft→superseded proposal trail) reference it.
 * `messages` partition by `job_id`. Threads are isolated for context hygiene — cross-thread coherence
 * is shared memory only, never transcript sharing.
 *
 * `status` (build lifecycle) is a SEPARATE axis from `thread_sandboxes.lifecycle` (container/worktree
 * infra). The branch + PR live HERE (single owner); the sandbox is the disposable workspace.
 */
@Entity({ name: 'jobs' })
@Index(['org_id', 'repo_id'])
@Index(['created_by_job_id'])
export class JobEntity extends TimestampedEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  /** The tenant (FK → organizations.id). */
  @Column({ type: 'uuid' })
  org_id!: string;

  @ManyToOne(() => OrganizationEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'org_id' })
  org?: OrganizationEntity;

  /** The repo this thread builds against (FK → repos.id). */
  @Column({ type: 'uuid' })
  repo_id!: string;

  @ManyToOne(() => RepoEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'repo_id' })
  repo?: RepoEntity;

  /** What opened the thread: 'chat' | 'event' | 'control' (operator-created). */
  @Column({ type: 'text' })
  origin!: string;

  /** The surface-native thread coordinate (e.g. the root message ts); null until posted. */
  @Column({ type: 'text', nullable: true })
  surface_thread_ref!: string | null;

  /** Short human-readable label (the feature/notification title). */
  @Column({ type: 'text', nullable: true })
  title!: string | null;

  /** The base branch the build cuts from (operator-picked; null → the repo's default_branch). */
  @Column({ type: 'text', nullable: true })
  base_branch!: string | null;

  /** The create_job firstMessage stored when a never-started job is born blocked (create_job dependsOn);
   *  replayed on wake, then cleared. Null for a job manually blocked while already running (it resumes its
   *  existing session on wake, no replay). */
  @Column({ type: 'text', nullable: true })
  blocked_seed_message!: string | null;

  /** The job whose brain spawned this one via create_job (FK → jobs.id, SET NULL). Null for
   *  operator/system top-level jobs. Powers the "Created jobs" children query. */
  @Column({ type: 'uuid', nullable: true })
  created_by_job_id!: string | null;

  @ManyToOne(() => JobEntity, { onDelete: 'SET NULL', nullable: true })
  @JoinColumn({ name: 'created_by_job_id' })
  createdByJob?: JobEntity | null;

  /** Immutable provenance snapshot captured at spawn, NEVER nulled — so the "Created by" link
   *  survives the creator being hard-deleted (the FK goes null, this doesn't). */
  @Column({ type: 'jsonb', nullable: true })
  created_by!: JobProvenance | null;

  // ── build lifecycle (folded in from the former `jobs` table) ───────────────────────────────────────
  /**
   * Build/job intent (see `JobKind`): 'feature' (many threads) | 'bugfix' (one) | 'onboarding' | 'event' |
   * 'review' (reviews an existing external PR, never builds). Null until scoped — but the operator can
   * pick a kind at creation, and system paths (event/onboarding) stamp it at insert.
   */
  @Column({ type: 'text', nullable: true })
  kind!: string | null;

  // 'scoping' | 'planning' | 'plan_reviewing' | 'awaiting_approval' | 'building' | 'master_review' | 'ready' | 'shipping' | 'pr_open' | 'merged' | 'amending' | 'blocked' | 'cancelled' | 'deleting'
  @Column({ type: 'text', default: 'scoping' })
  status!: string;

  /**
   * The SHIP-REVIEW gate marker — stamped by the ship-review approval click (the "Ship it" button), null
   * otherwise. The driver's ship gate (between master review finishing and opening the PR) reads this to
   * tell "just parked, waiting on the operator" (null → flip to `awaiting_ship_review` and stop) from
   * "operator approved, proceed" (set → fall through to `finalizeBuild`). CLEARED when a NEW build cycle is
   * dispatched (a fresh plan approval) so the next ship re-gates; a re-drive after ship-approval preserves
   * it. Only driver builds (feature/bugfix) gate; see the `awaiting_ship_review` status.
   */
  @Column({ type: 'timestamptz', nullable: true })
  ship_review_approved_at!: Date | null;

  /**
   * The durable HUMAN-INPUT GATE: how many `ask_question` cards on this thread are still awaiting an
   * operator answer. Each card carries its OWN lifecycle (`answer`/`answeredAt`/`deliveredAt`) — there is
   * NO single-slot pointer, so the brain may have several questions open at once, answerable in any order.
   * This denormalized counter is the cheap "needs you" signal (REST list + WAL realtime): bumped by
   * `openQuestion`, decremented by `markQuestionAnswered`, and recomputed from the cards on boot
   * (`reconcileOpenQuestionCounts`) so it can never wedge. Answered-but-undelivered recovery keys off the
   * card rows, not this counter.
   */
  @Column({ type: 'int', default: 0 })
  open_question_count!: number;

  /**
   * The EPHEMERAL-ONLY secure-secret gate — the `requestId` of a `request_secret({ ephemeral: true })` card
   * (an OAuth verification code, a 2FA code) this thread is awaiting an operator value for, or null. That
   * lane stays single-slot/immediate because it pipes a one-time value straight into a live waiting process
   * (there is nothing to gain from stacking several). Durable/MCP-target secret requests do NOT use this
   * column anymore — they are PER-CARD like `request_file`, gated on the card's own
   * `provided_at`/`delivered_at`/`withdrawnAt` (see `open_secret_count` below). Set atomically with the
   * ephemeral card by `request_secret` (`BrainStoreService.openSecretRequest`). The value itself NEVER lands
   * here or in the transcript — it is piped straight into the running process via `provide-secret`, which
   * stamps the card `provided_at`; this gate is cleared only once the masked-confirmation delivery turn
   * succeeds (so a crash mid-delivery re-delivers on boot).
   */
  @Column({ type: 'text', nullable: true })
  awaiting_secret_id!: string | null;

  /**
   * The durable/MCP SECURE-SECRET gate — how many durable-path/MCP-target `request_secret` cards on this
   * thread are still open (posted, not yet provided or withdrawn). Each such card carries its OWN lifecycle
   * (`provided_at`/`delivered_at`/`withdrawnAt` in `messages.card` jsonb) — there is NO single-slot pointer
   * for this lane, so the brain may have several secret requests open at once, fillable in any order (mirrors
   * `open_question_count`). This denormalized counter is the cheap "needs you" + auto-merge-hold signal:
   * bumped by the durable/mcp branch of `openSecretRequest`, decremented by `provideSecret`/
   * `withdrawSecretRequest`, and recomputed from the cards on boot (`reconcileOpenSecretCounts`) so it can
   * never wedge. The EPHEMERAL lane does not touch this counter — it keeps signaling via `awaiting_secret_id`.
   */
  @Column({ type: 'int', default: 0 })
  open_secret_count!: number;

  /** The locked decision record (FK → decision_records.id); null until the upfront grill produces one. */
  @Column({ type: 'uuid', nullable: true })
  decision_record_id!: string | null;

  @ManyToOne(() => DecisionRecordEntity, {
    onDelete: 'SET NULL',
    nullable: true,
  })
  @JoinColumn({ name: 'decision_record_id' })
  decisionRecord?: DecisionRecordEntity | null;

  /**
   * The CANONICAL feature branch name all threads stack on — computed host-side from the repo's
   * branch-naming prefix at provision time and stored as the exact name Atlas must `git checkout -b`
   * in the sandbox. Atlas OWNS the actual branch creation/push now; the host only names it (so GitHub
   * events correlate back to this job by branch). Null until the name is assigned.
   */
  @Column({ type: 'text', nullable: true })
  feature_branch!: string | null;

  /**
   * The branch the sandbox's HEAD is actually on right now — sampled at each turn boundary
   * (`git symbolic-ref --short HEAD`). OBSERVED, never asserted: pre-PR it mirrors the work; once a PR
   * exists it stays a display field, and a divergence from {@link feature_branch} is surfaced as DRIFT
   * (not blocked). Null until first sampled / on detached HEAD.
   */
  @Column({ type: 'text', nullable: true })
  current_branch!: string | null;

  /** Tri-state sidebar port badge, written change-gated by ExposureService.reconcile:
   *  'exposed' (≥1 running service with a public URL) | 'internal' (running, none exposed) | null. */
  @Column({ type: 'text', nullable: true })
  port_state!: 'exposed' | 'internal' | null;

  /** The opened PR url; null until the PR-tail thread group opens one. */
  @Column({ type: 'text', nullable: true })
  pr_url!: string | null;

  /** The opened PR number — what the merge poll queries GitHub with; null until opened. */
  @Column({ type: 'int', nullable: true })
  pr_number!: number | null;

  /**
   * Last observed CI conclusion for the PR head (e.g. `success | failure | pending`) — set by the
   * reconciler from GitHub check-runs, surfaced as a UI badge. Null until first reconciled.
   */
  @Column({ type: 'text', nullable: true })
  ci_status!: string | null;

  /**
   * Per-category CI check counts for the PR head (`{ failing, pending, passed, skipped, total }`) —
   * computed alongside `ci_status` in the same reconciler + webhook-sync recompute. Null exactly when
   * `ci_status` is null (no check-runs reported for the head SHA).
   */
  @Column({ type: 'jsonb', nullable: true })
  ci_counts!: CiCounts | null;

  /** Sidebar build-stage progress, written change-gated by DriverStoreService.recomputeBuildStageProgress:
   *  count of build/direct_build thread groups whose builders are all done, out of the total. null = n/a. */
  @Column({ type: 'int', nullable: true })
  build_stages_done!: number | null;

  @Column({ type: 'int', nullable: true })
  build_stages_total!: number | null;

  /**
   * Last observed GitHub PR `mergeable_state` (e.g. `clean | dirty | behind | blocked`) — set by the
   * reconciler; `dirty` drives the merge-conflict badge + the conflict harness event to the brain.
   * Null until first reconciled (GitHub also reports it transiently null while computing).
   */
  @Column({ type: 'text', nullable: true })
  pr_mergeable!: string | null;

  /**
   * Observed PR LIFECYCLE state (`open | merged | closed`) — the reconciler/teardown-owned column that
   * drives the sidebar's PR-status glyph (green ready / amber conflict / purple merged / red closed).
   * SEPARATE from {@link status} (the build lifecycle, which latches to `done` the moment a PR opens and
   * can't distinguish open-vs-merged) and from {@link pr_mergeable} (the merge-conflict signal). Latched
   * to `open` when the PR is recorded (`setPrReady` / reconciler discovery) and to its terminal value by
   * `pollPrClosures` before the sandbox is torn down (the job row SURVIVES a merge — never auto-deleted).
   * Null until a PR exists.
   */
  @Column({ type: 'text', nullable: true })
  pr_state!: string | null;

  /**
   * The DURABLE adaptive-poll clock — "re-check this PR's GitHub state at/after this instant". Owned by
   * the `GitStateReconciler`: its fast heartbeat selects only DUE jobs (`next_poll_at IS NULL OR <= now()`),
   * reconciles each, then re-stamps this by an adaptive cadence — ~8s while GitHub is still computing
   * `mergeable_state`, ~45s for a settled open PR, ~3min for a branch still building with no PR yet, and
   * CLEARED (null) once the PR is merged/closed/gone (teardown owns it). Durable (not an in-memory timer)
   * so it survives the constant prod restarts that starved the old fixed sweep, survives leader failover,
   * AND lets a base-branch push mark every open PR on a repo due-now with one `UPDATE` (the real-time
   * base-move-conflict unlock). Null = due immediately (a fresh row is polled on the next heartbeat).
   */
  @Column({ type: 'timestamptz', nullable: true })
  next_poll_at!: Date | null;

  /**
   * The DURABLE auto-resume clock — when a lane is parked on a Claude session/usage limit, the ISO
   * instant it should auto-resume. Null = not parked. Swept leader-only (`SessionResumeSweep`, mirroring
   * `GitStateReconciler`'s `next_poll_at` due-query pattern: `WHERE session_resume_at <= now()`); cleared
   * on resume (auto or force). The conversational session-backed lanes (planner/post_build/ship) have no
   * `halt` at all, so they need this column regardless of the build-lane's `halt.resumeAt`.
   */
  @Column({ type: 'timestamptz', nullable: true })
  session_resume_at!: Date | null;

  /** Durable mirror of AgentSessionManager.benignAbortRedrives. Reset to 0 on a clean turn; survives a
   *  restart/crash-loop so a stuck job can't silently regain a fresh in-memory budget on every boot. */
  @Column({ type: 'int', default: 0 })
  benign_abort_redrives!: number;

  /** Durable mirror of AgentSessionManager.transientRetryRedrives (host-transport auto-retry budget). */
  @Column({ type: 'int', default: 0 })
  transient_retry_redrives!: number;

  /** Durable mirror of ThreadDriver.authRetryAttempts (transient-auth auto-retry budget). */
  @Column({ type: 'int', default: 0 })
  auth_retry_attempts!: number;

  /** Durable mirror of the ThreadDriver.runJobWithTransientRetry loop counter (transient-drive infra-blip
   *  budget) — today a bare local var that resets on every drive() re-entry AND every restart. */
  @Column({ type: 'int', default: 0 })
  driver_transient_retries!: number;

  /** Last time ANY retry fired for this job (auto host-retry OR a manual Resume). Backstops the auto-retry
   *  backoff across a restart (so a crash-loop can't fire retries back-to-back) and powers the manual
   *  re-slam cooldown (thread 2). Null = never retried. */
  @Column({ type: 'timestamptz', nullable: true })
  retry_last_attempt_at!: Date | null;

  /** Consecutive UNCORROBORATED text-fallback session-limit misfires for this job. Reset on any clean turn
   *  or durable park; escalates the lane to a durable park once it hits
   *  `SESSION_LIMIT_TEXT_MISFIRE_MAX`. */
  @Column({ type: 'int', default: 0 })
  session_limit_text_misfires!: number;

  /**
   * The WORKING SET of decisions locked during grilling via `create_decision`, BEFORE any proposal exists.
   * Deliberately separate from `decision_records` so the proposal lifecycle (a fresh record + supersede
   * on every `submit_plan`) stays intact: `submit_plan` snapshots this set into a new decision record.
   * Each entry carries a stable `id` (`d1`, `d2`…); `update_decision`/`delete_decision` address it by id.
   * The generated `/context/generated/decision-record.md` is rendered from this array, live, on every
   * decision mutation.
   */
  @Column({ type: 'jsonb', default: [] })
  pending_decisions!: Decision[];

  /**
   * When the DIRECT build actually STARTED — stamped the instant `dispatch_build` appends the direct-build
   * builder Section (post base-check, plan judged valid). This is the durable "the direct build has started"
   * marker: it flips at the START, so {@link BrainStoreService.buildNotStarted} can close the pre-start
   * base-check window the moment the build is dispatched. Without it `hold_build` would stay callable and
   * could reopen planning underneath a live build. Null for jobs that never ran a direct build.
   */
  @Column({ type: 'timestamptz', nullable: true })
  direct_build_started_at!: Date | null;

  /**
   * Which BUILD PATH this job runs: 'direct' (the fast, brain-implemented path) or 'plan' (the
   * driver-run multi-thread path, the default). Set at job creation — the scheduler reads it to decide
   * whether a `section` thread group runs review children + spawns `master_review`. The UI reads this
   * (surfaced as `buildPath` on the pipeline DTO) to suppress the plan-oriented empty-state placeholders —
   * build lanes, `plan.md`, generated docs — that never apply to a direct build.
   */
  @Column({ type: 'text', default: 'plan' })
  build_path!: 'direct' | 'plan';

  /**
   * The server-authoritative ROUTING pointer the console opens to (FK → threads.id, SET NULL). Distinct
   * from session liveness (whether a thread currently has a running session) — this is purely "which
   * thread does /workspace/:jobId/:threadId resolve to". The host advances it as the pipeline moves
   * (create → planner thread; approve → the first Section's first Leg; etc.); an operator click on a
   * thread in the sidebar overrides it. Named "focused", deliberately not "active", to keep routing
   * separate from liveness. Null only in the sliver before the planner thread is created.
   */
  @Column({ type: 'uuid', nullable: true })
  focused_thread_id!: string | null;

  @ManyToOne(() => ThreadEntity, { onDelete: 'SET NULL', nullable: true })
  @JoinColumn({ name: 'focused_thread_id' })
  focusedThread?: ThreadEntity | null;

  /** Per-job AUTO-APPROVE MODE: which of the plan-approval / ship-review gates on this job auto-advance
   *  with no human click (still posting the card for audit). Seeded from the org's
   *  `default_auto_approve_mode` at creation when the create-job request omits an explicit value (see
   *  `createJob`); independently overridable per job afterward — no live link back to the org. */
  @Column({ type: 'text', default: 'off' })
  auto_approve_mode!: AutoApproveMode;

  /** Who most recently ENABLED auto-approve (FK → users.id, SET NULL) — used as the approver id when a
   *  gate auto-resolves. Null when never enabled / the enabling user was deleted (gate falls back to the
   *  org owner). Not cleared on disable (kept for audit). */
  @Column({ type: 'uuid', nullable: true })
  auto_approve_by!: string | null;

  @ManyToOne(() => UserEntity, { onDelete: 'SET NULL', nullable: true })
  @JoinColumn({ name: 'auto_approve_by' })
  autoApproveByUser?: UserEntity | null;

  /** Per-job AUTO-MERGE master toggle: when on, a merge-ready open PR auto-merges (host auto-clicks the
   *  Merge gate). Orthogonal to auto_approve_mode — a human may still gate plan/ship while Atlas babysits
   *  the PR to green and merges it. Seeded from the org's `default_auto_merge` at creation when the
   *  create-job request omits an explicit value (see `createJob`); independently overridable per job
   *  afterward — no live link back to the org. */
  @Column({ type: 'boolean', default: false })
  auto_merge!: boolean;

  /** Who most recently ENABLED auto-merge (FK → users.id, SET NULL) — the approver id stamped on an
   *  auto-clicked merge. Null when never enabled / the user was deleted (falls back to org owner). Not
   *  cleared on disable (kept for audit). */
  @Column({ type: 'uuid', nullable: true })
  auto_merge_by!: string | null;

  @ManyToOne(() => UserEntity, { onDelete: 'SET NULL', nullable: true })
  @JoinColumn({ name: 'auto_merge_by' })
  autoMergeByUser?: UserEntity | null;
}
