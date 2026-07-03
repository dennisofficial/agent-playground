import { Column, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn } from 'typeorm';
import { TimestampedEntity } from '@workspace/shared/schemas';
import type { Decision } from '../../domain/decision-record';
import { DecisionRecordEntity } from './decision-record.entity';
import { OrganizationEntity } from './organization.entity';
import { RepoEntity } from './repo.entity';
import type { ReviewAgentState, TaskItem } from './thread.entity';
import { TicketEntity } from './ticket.entity';

/**
 * One buffered, not-yet-conveyed pipeline milestone (the transient-moment record). `id` is an
 * idempotency key — a build stage emits the same id repeatedly (the driver fires many events per step),
 * the buffer keeps exactly one. `text` is the passive line shown to the brain; `at` orders the prefix.
 */
export interface PipelineMarker {
  id: string;
  text: string;
  /** ISO-8601 emission time. */
  at: string;
}

/**
 * The PASSIVE pipeline-milestone awareness buffer (see `driver/pipeline-awareness.*`). NOT a turn
 * trigger — milestones append here while the brain is idle and are drained + prepended to the next
 * OPERATOR turn so the brain passively knows where the build stands.
 *  - `markerQueue` — transient named milestones not yet conveyed (deduped by `id`, drained atomically).
 *  - `conveyedStateSig` — signature of the last net-current-state summary already conveyed, so the
 *    state diff only re-states on a real change (null until the first state is conveyed).
 */
export interface ThreadPipelineAwareness {
  markerQueue: PipelineMarker[];
  conveyedStateSig: string | null;
}

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

  /**
   * The ticket this thread was promoted from / works (FK → tickets.id); null for a thread not tied to a
   * ticket. A thread works AT MOST one ticket — enforced 1:1 by a partial unique index
   * (`uq_threads_ticket_id` WHERE ticket_id IS NOT NULL), hand-added in the migration. SET NULL if the
   * ticket is deleted (the thread/PR outlives the board entry).
   */
  @Column({ type: 'uuid', nullable: true })
  ticket_id!: string | null;

  @ManyToOne(() => TicketEntity, { onDelete: 'SET NULL', nullable: true })
  @JoinColumn({ name: 'ticket_id' })
  ticket?: TicketEntity | null;

  // ── build lifecycle (folded in from the former `jobs` table) ───────────────────────────────────────
  /** Build intent: 'feature' (many threads) | 'bugfix' (one). Null until the thread is scoped. */
  @Column({ type: 'text', nullable: true })
  kind!: string | null;

  // 'open' | 'planning' | 'awaiting_approval' | 'running' | 'paused' | 'done' | 'failed' | 'cancelled'
  @Column({ type: 'text', default: 'open' })
  status!: string;

  /**
   * Whether a live conversational (brain) turn is streaming RIGHT NOW. Toggled around `runChatTurn`
   * (true for its whole duration, including provisioning; cleared in a `finally`). A SEPARATE axis from
   * `status` — together they yield the "needs you" signal (see `deriveNeedsYou`): `status` covers build
   * activity, `turn_active` covers conversation activity. Reset to false on boot (no turn survives a
   * process restart) so a crash mid-turn can't leave a thread looking "working" forever.
   */
  @Column({ type: 'boolean', default: false })
  turn_active!: boolean;

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
   * The durable SECURE-SECRET gate — the `requestId` of a `request_secret` card this thread is awaiting an
   * operator value for, or null. Kept SEPARATE so the two human-input lanes don't collide and so secret
   * delivery keeps its own crash-safe lifecycle (still single-slot — at most one secret request at a time). Set
   * atomically with the secret card by `request_secret` (`BrainStoreService.openSecretRequest`). The value
   * itself NEVER lands here or in the transcript — it goes straight to the encrypted `WorktreeSecretStore`
   * via the `provide-secret` endpoint, which stamps the card `provided_at`; this gate is cleared only once
   * the masked-confirmation delivery turn succeeds (so a crash mid-delivery re-delivers on boot).
   */
  @Column({ type: 'text', nullable: true })
  awaiting_secret_id!: string | null;

  /** The locked decision record (FK → decision_records.id); null until the upfront grill produces one. */
  @Column({ type: 'uuid', nullable: true })
  decision_record_id!: string | null;

  @ManyToOne(() => DecisionRecordEntity, { onDelete: 'SET NULL', nullable: true })
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

  /** The opened PR url; null until the PR-tail stage opens one. */
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
   * Last observed GitHub PR `mergeable_state` (e.g. `clean | dirty | behind | blocked`) — set by the
   * reconciler; `dirty` drives the merge-conflict badge + the conflict harness event to the brain.
   * Null until first reconciled (GitHub also reports it transiently null while computing).
   */
  @Column({ type: 'text', nullable: true })
  pr_mergeable!: string | null;

  /**
   * The PR-TAIL review agents (lenses) + their per-agent status — the JOB-level twin of
   * {@link ThreadEntity.review_agents}. Seeded at `pending` when the PR-tail auto-fix pass starts
   * (`BuildShipService.ship`), transitioned as each lens runs, surfaced by `getPipelineState` so the
   * navigator's job-level "Final review" node can show each agent's state. `[]` until the PR-tail runs.
   * LITERAL default — a function default loops `migration:generate` (see the jsonb-default-loop memory).
   */
  @Column({ type: 'jsonb', default: [] })
  review_agents!: ReviewAgentState[];

  /**
   * The PR Review orchestrator's LLM-authored task list — the JOB-level twin of
   * {@link ThreadEntity.tasks}, folded incrementally from its `TaskCreate`/`TaskUpdate` tool calls at the
   * shared transcript harness. `[]` until the orchestrator creates its first task. LITERAL default — see
   * the `review_agents` doc above for why a function default breaks `migration:generate`.
   */
  @Column({ type: 'jsonb', default: [] })
  tasks!: TaskItem[];

  /**
   * The PR Review orchestrator's card-header state (`queued | reviewing | fixing | verifying | opened |
   * failed`) — null until `BuildShipService.ship()` starts the orchestrator session. Separate from
   * {@link status} (the thread's own build lifecycle), which is already `done`/terminal by the time PR
   * Review runs. `opened` (not `merged`) because Atlas only opens the PR — merging stays a manual GitHub
   * action.
   */
  @Column({ type: 'text', nullable: true })
  pr_review_status!: string | null;

  /**
   * The MAIN brain session's own LLM-authored task list (the navigator's Main-row checklist), folded from
   * its `TaskCreate`/`TaskUpdate` calls on the `main` lane — a SEPARATE column from {@link tasks} (the PR
   * Review orchestrator's list) so `startPrReview`'s task reset can never wipe the brain's checklist.
   * LITERAL default — see the `review_agents` doc above for why a function default breaks
   * `migration:generate`.
   */
  @Column({ type: 'jsonb', default: [] })
  main_tasks!: TaskItem[];

  /**
   * PASSIVE pipeline-milestone awareness buffer — durable per-thread record of build milestones the
   * brain hasn't been told about yet + the watermark of the last pipeline state conveyed. Drained and
   * prepended to the next OPERATOR turn's input (never pushed; never wakes the brain). See the
   * `ThreadPipelineAwareness` doc + `driver/pipeline-awareness.store.ts`.
   */
  @Column({
    type: 'jsonb',
    // Plain-literal default (NOT a `() => '...'::jsonb` expression): only a non-function
    // default routes TypeORM's `defaultEqual` through its jsonb-aware deepCompare branch.
    // A function default falls back to naive string compare, which never matches the
    // cast-stripped, whitespace-normalized value Postgres reads back → migration regenerates forever.
    default: { markerQueue: [], conveyedStateSig: null },
  })
  pipeline_awareness!: ThreadPipelineAwareness;

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
   * DURABLE DECISION-LEDGER PROMOTION SPINE — the lifecycle marker for promoting this thread's durable
   * decisions into the committed `.atlas/decisions/` ledger at ship time. SEPARATE from
   * {@link ledger_promoted_at} on purpose: a single field can't both CLAIM the work and PROVE it
   * finished (a crash after claim, before the ledger commit, would look done forever). Mirrors the
   * `plan_reviews` spine (status + a completion timestamp). Values: `pending | running | complete |
   * failed`; null = never started. Claimed atomically (null/pending/failed → `running`); the resumable
   * driver (`finishWithPr`) + a fail-soft boot backstop re-run anything stuck in `running`.
   */
  @Column({ type: 'text', nullable: true })
  ledger_promotion_status!: string | null;

  /**
   * Stamped ONLY after the promotion turn AND the ledger commit both succeed — the proof-of-completion
   * half of the spine (see {@link ledger_promotion_status}). Null until then; its presence is what tells
   * recovery the ledger is already written so it must not re-run.
   */
  @Column({ type: 'timestamptz', nullable: true })
  ledger_promoted_at!: Date | null;
}
