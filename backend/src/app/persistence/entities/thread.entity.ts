import { Column, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn } from 'typeorm';
import { TimestampedEntity } from '@workspace/shared/schemas';
import { OrganizationEntity } from './organization.entity';
import { JobEntity } from './job.entity';
import type { ReviewFinding } from '../../autofix/autofix.types';

/**
 * One THREAD of a job — a first-class, typed lane differentiated only by `kind` (`main | builder |
 * master_review | review_lens | post_review | plan_review`) and related by `parent_thread_id` (a builder
 * is the parent of its `review_lens`/`post_review` children). Builders stack on the job's one feature
 * branch and run sequentially (ORDER BY ordinal); children hang off their builder. `status` is the
 * explicit, resumable cursor. Gap-numbered ordinals so a re-plan can splice without renumbering.
 *
 * Which kinds the driver actually EXECUTES vs merely renders is owned by the `thread-kind` registry
 * (`ThreadKindSpec`), not this row — the row is just typed state + tree structure.
 */
@Entity({ name: 'threads' })
@Index(['job_id'])
@Index(['parent_thread_id'])
// Hands-off: uq_threads_job_parent_ordinal is UNIQUE … NULLS NOT DISTINCT, unexpressible in TypeORM
// metadata. The DDL lives in the migrations; this only tells migration:generate never to DROP it.
@Index('uq_threads_job_parent_ordinal', { synchronize: false })
export class ThreadEntity extends TimestampedEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  /** The owning job (FK → jobs.id). */
  @Column({ type: 'uuid' })
  job_id!: string;

  @ManyToOne(() => JobEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'job_id' })
  thread?: JobEntity;

  /**
   * The thread KIND — `main | builder | master_review | review_lens | post_review | plan_review`. The
   * single differentiator across all thread-like concepts (subsumes `is_master_review`). The `thread-kind`
   * registry binds each kind to a prompt-kit `Agent`, an engine, a driver mode, and its children. Executable
   * kinds (`builder`, `master_review`) are driven as top-level sections; `review_lens`/`post_review` are
   * driven as children; `main`/`plan_review` are render/identity-only (their runtime lives elsewhere).
   * No column default — every write site sets it explicitly (persistPlan / the child-thread materializer).
   */
  @Column({ type: 'text' })
  kind!: string;

  /**
   * Self-FK (→ threads.id) — the parent thread in the tree. A `builder` is the parent of its `review_lens`
   * and `post_review` children; `main`/`master_review`/`plan_review` are root/job-level (null). Indexed;
   * FK cascades with the rest so deleting a builder deletes its review children.
   */
  @Column({ type: 'uuid', nullable: true })
  parent_thread_id!: string | null;

  @ManyToOne(() => ThreadEntity, { onDelete: 'CASCADE', nullable: true })
  @JoinColumn({ name: 'parent_thread_id' })
  parent?: ThreadEntity | null;

  /**
   * Kind-specific params: `review_lens → { lensId }`, `post_review → { minSeverity }`, `master_review →
   * { diffRange }`. PLAIN-LITERAL default (a `() => '{}'::jsonb` function default makes `migration:generate`
   * loop forever — see the jsonb-default-loop memory).
   */
  @Column({ type: 'jsonb', default: {} })
  config!: Record<string, unknown>;

  /**
   * The FULL `ReviewFinding[]` a `review_lens` thread produced — the complete findings, not just a count.
   * `post_review` reads this off its sibling lens rows, dedupes + filters by `minSeverity`, and feeds
   * `buildFixPrompt`. Null until the lens has reviewed (per-lens display count/verdict derive from this).
   * Nullable, no default (mirrors `terminal_record`).
   */
  @Column({ type: 'jsonb', nullable: true })
  review_findings!: ReviewFinding[] | null;

  /** The tenant (org id) — denormalized for org-scoped queries (FK → organizations.id). */
  @Column({ type: 'uuid' })
  org_id!: string;

  @ManyToOne(() => OrganizationEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'org_id' })
  org?: OrganizationEntity;

  /** Execution order within the thread, GAP-NUMBERED (10, 20, 30…) so a re-plan can splice. */
  @Column({ type: 'int' })
  ordinal!: number;

  /** The one-line brief (title) from the upfront thread list. */
  @Column({ type: 'text' })
  brief!: string;

  /**
   * The scope TYPE of this thread (backend/frontend/docs/testing/analytics/infra/…) — selects the
   * review agents that check it. A fixed vocabulary (THREAD_TYPES) with an allow-other escape hatch;
   * defaults to 'general' for arg-less callers (bugfix/direct build).
   */
  @Column({ type: 'text', default: 'general' })
  type!: string;

  /** The detailed plan once authored/generated; null while pending. Steps LOCK once planned. */
  @Column({ type: 'text', nullable: true })
  plan!: string | null;

  /**
   * A compact repo-orientation cheat-sheet from the plan turn (repo layout + the REAL verify commands),
   * handed to the fresh builder session via the execute task so it need not rediscover the repo. Persisted
   * so a resume that skips re-planning still has it. Null while pending.
   */
  @Column({ type: 'text', nullable: true })
  orientation!: string | null;

  /** The prior thread's handoff note threaded into this thread's plan prompt. */
  @Column({ type: 'text', nullable: true })
  handoff_in!: string | null;

  /** This thread's handoff note for the next thread; null until done. */
  @Column({ type: 'text', nullable: true })
  handoff_out!: string | null;

  // 'pending' | 'planning' | 'reviewing' | 'executing' | 'auto_fixing' | 'done' — the PURE LINEAR step (pause/failure/skip live on `condition`)
  @Column({ type: 'text', default: 'pending' })
  status!: string;

  // 'none' | 'paused' | 'incomplete' | 'failed' | 'skipped' — the orthogonal condition overlay (ADR-0004 detail stays in terminal_record/halt_outcome)
  @Column({ type: 'text', default: 'none' })
  condition!: string;

  /**
   * The thread's LLM-authored task list — folded incrementally from the orchestrating session's
   * `TaskCreate`/`TaskUpdate` tool calls at the shared transcript harness (see `TurnHarnessFactory`), so
   * the navigator's TASKS section renders durable state instead of the client refolding the transcript.
   * `[]` until the session creates its first task — there is no fixed/expected set, so `getPipelineState`
   * does NOT fall back to a computed default here. LITERAL default — a `() => '[]'::jsonb` function default
   * makes `migration:generate` loop forever (see the jsonb-default-loop memory).
   */
  @Column({ type: 'jsonb', default: [] })
  tasks!: TaskItem[];

  /**
   * The RUNNING log of out-of-scope fixes the orchestrator made INLINE while building this thread — each a
   * small, clearly-correct repair outside the assignment (a dead href, a wrong import) recorded via the
   * `record_deviation` host tool the moment it's made, NOT deferred to the final report. The durable source
   * of truth behind the `/context/generated/deviations.md` projection (that file is a pure re-render of this
   * across the job's threads — `/context/generated` is read-only in the sandbox, so the host owns the write).
   * Distinct from `terminal_record.deviations` (a one-shot end-of-turn summary). LITERAL default — a
   * `() => '[]'::jsonb` function default makes `migration:generate` loop forever (jsonb-default-loop memory).
   */
  @Column({ type: 'jsonb', default: [] })
  deviations!: DeviationEntry[];

  /**
   * The thread's TYPED terminal assertion — written by the orchestrator's `complete_thread`/`block_thread`
   * tool call at the end of its build turn, then READ by the driver to decide the thread's outcome instead
   * of inferring it from whether the turn threw (ADR 0004). Null until the tool is called; a clean turn
   * that never wrote one is treated as `incomplete`, NOT `done`. `nullable` (no jsonb function-default — a
   * `() => '...'::jsonb` default makes `migration:generate` loop forever; nullable avoids a default entirely).
   */
  @Column({ type: 'jsonb', nullable: true })
  terminal_record!: ThreadTerminalRecord | null;

  /**
   * Phase 3 (ADR 0004 rider 4) — the "a halt is OWED a brain wake" signal. Set by the driver's `haltJob`
   * to the non-`done` outcome (`blocked`/`incomplete`/`failed`) the moment a thread halts; the driver then
   * wakes the job brain to triage it. Distinct from `terminal_record` (which is null for `incomplete`) and
   * from a `request_operator_input` `awaiting_input` pause (which never sets this), so the owed-wake sweep
   * keys on it unambiguously. Cleared on a re-drive so a fresh halt re-arms the wake. Null = no owed halt.
   */
  @Column({ type: 'text', nullable: true })
  halt_outcome!: string | null;

  /**
   * Phase 3 halt-wake DEDUP marker. Stamped (generation-checked against `halt_fix_attempts`) only AFTER the
   * brain wake turn is delivered; NULL while a wake is owed, so a crash before the stamp lets the boot sweep
   * re-fire (at-least-once, matching the event/chat delivery sweeps). Cleared on a re-drive.
   */
  @Column({ type: 'timestamptz', nullable: true })
  halt_waked_at!: Date | null;

  /**
   * Phase 3 LIFETIME autonomous re-drive budget AND the generation token for the wake-stamp CAS. CAS-
   * incremented by the brain's `retry_thread` tool before each re-drive; over the cap the tool refuses and
   * the brain must escalate. The increment also invalidates a stale wake's late stamp. Never resets.
   */
  @Column({ type: 'int', default: 0 })
  halt_fix_attempts!: number;

  /**
   * The thread's START HEAD — the feature-branch sha captured ONCE, the first time the thread begins
   * executing. The post-build review scopes its diff by `start_sha..HEAD` and commit-recording compares
   * HEAD against it (thread-driver `:1733`); RE-capturing it on every (re)entry lets a RESUME grab it AFTER
   * the thread already committed (start === HEAD → an empty range → the review is silently skipped and the
   * commit mis-recorded as `(nothing)`). Persisted + set-once so a resume reuses the true base. Null until
   * first execute (or for threads created before this field existed — the range then falls back to a live
   * capture at run time).
   */
  @Column({ type: 'text', nullable: true })
  start_sha!: string | null;
}

/**
 * A thread's typed terminal assertion (see {@link ThreadEntity.terminal_record}). The orchestrator writes
 * exactly one at the end of its work; the driver reads it to branch done / blocked / failed / incomplete.
 */
export interface ThreadTerminalRecord {
  status: 'done' | 'blocked' | 'failed';
  /** One-line summary of what the thread did (or why it's blocked/failed). */
  summary: string;
  /** What changed, terse — feeds the next thread's handoff. */
  changes?: string[];
  /** Verification the orchestrator actually ran, with captured evidence (not prose claims). */
  verification?: { kind: string; command: string; exitCode: number; outputTail: string }[];
  /** Off-spec changes the orchestrator flagged. */
  deviations?: string[];
  /** Honest known gaps / things to know — routed to the brain + next-thread orientation. */
  gaps?: string[];
  /** Set when status='blocked' (Phase 3 `block_thread`, or the ADR-0005 live-verification judge downgrade).
   *  `judge_unavailable` is distinct from `unverified`: the work may well be verified, but the judge itself
   *  was UNREACHABLE (transient Anthropic outage / key rate-or-credit limit) — a done thread must HOLD and
   *  retry when the service recovers, NOT burn its autonomous fix budget and rest as `budget_exhausted`. */
  blocked?: {
    reason: 'question' | 'needs_env' | 'decision' | 'unverified' | 'judge_unavailable';
    detail: string;
  };
  /** Set when status='failed' — the structured failure the driver relays. */
  failure?: {
    kind: 'build' | 'verification';
    failingStep?: string;
    command?: string;
    exitCode?: number;
    stderrTail?: string;
  };
  /** The ADR-0005 live-verification judge's verdict on this claim, when the gate ran. The basis for the
   *  `blocked`/`unverified` downgrade above (also recorded when the claim passed, for observability). */
  liveVerification?: {
    verdict: {
      runtimeSurfaceTouched: boolean;
      liveVerificationAdequate: boolean;
      reason: string;
      missingChecks?: string;
    };
  };
}

/** One inline out-of-scope fix the orchestrator made while building a thread (see {@link ThreadEntity.deviations}). */
export interface DeviationEntry {
  /** One line: what was changed off-spec and why. */
  note: string;
  /** ISO timestamp the deviation was recorded. */
  ts: string;
}

/** One post-build review agent as the `/pipeline` read-model surfaces it — DERIVED at read time from a
 *  builder's `review_lens` child rows (each row's status + findings), no longer a persisted column. */
export interface ReviewAgentState {
  id: string;
  label: string;
  status: 'pending' | 'running' | 'passed' | 'failed' | 'skipped';
  findings?: number;
}

/** One LLM-authored task, folded from `TaskCreate`/`TaskUpdate` tool calls (see `ThreadEntity.tasks`). */
export interface TaskItem {
  id: string;
  subject: string;
  status: 'pending' | 'in_progress' | 'completed' | 'dropped';
  /** The SDK task's longer description — the navigator shows it under an in_progress task + as tooltip. */
  description?: string;
  /** Present-continuous label ("Resolving the router chain") shown while in_progress; falls back to subject. */
  activeForm?: string;
  /** Dependency edges — ids of tasks this one waits on. A PENDING task with an incomplete blocker renders
   *  BLOCKED; the block clears by derivation when every blocker completes or is deleted. */
  blockedBy?: string[];
}
