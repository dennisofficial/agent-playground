import { Injectable } from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { DataSource, IsNull, Repository } from 'typeorm';
import { randomUUID } from 'node:crypto';
import type {
  Decision,
  DecisionRecord,
  Step,
  StepStatus,
  Thread,
  ThreadStatus,
  ThreadCondition,
  Job,
  JobActivity,
  JobStatus,
  JobHalt,
} from '../domain';
import { DB_CONNECTION } from '../persistence/database.module';
import {
  BuildLegEntity,
  DecisionRecordEntity,
  MessageEntity,
  StepEntity,
  ThreadEntity,
  JobEntity,
  CodexReviewEntity,
} from '../persistence/entities';
import type {
  DeviationEntry,
  SessionAnchor,
  TaskItem,
  ThreadTerminalRecord,
} from '../persistence/entities';
import type { ReviewFinding } from '../autofix';
import { isDriverExecutableKind, laneDefaultFooter, threadKindSpec } from '../thread-kind';
import { laneFor } from '../surface/thread-registry';
import type { WebQuestionCard } from '../surface/web-question-card';
import { webVerdictCard } from '../surface/web-approval-card';
import type { PlannedStep } from './render-plan';

/** Phases are gap-numbered (10, 20, 30…) so a re-plan can splice without renumbering. */
const ORDINAL_GAP = 10;

/**
 * The thread shape the driver works with — the domain `Thread` plus the denormalized `orgId` the step
 * rows need (steps carry `org_id`). The driver never reaches a repository, so the store carries the one
 * extra field rather than the driver re-querying the thread for it.
 */
export type DriverThread = Thread & { orgId: string };

/**
 * A builder's review CHILD thread (a `review_lens` or `post_review` row) as the driver's child-thread
 * orchestration works with it — the kind + config + status + the full findings a lens produced. Distinct
 * from `DriverThread` (a top-level build lane); children carry `config`/`reviewFindings`, not a plan/handoff.
 */
export interface ReviewChildThread {
  id: string;
  kind: string;
  brief: string;
  ordinal: number;
  config: Record<string, unknown>;
  status: ThreadStatus;
  condition: ThreadCondition;
  reviewFindings: ReviewFinding[] | null;
}

/** Where to post a thread's chatter — the repo coordinate + the real thread id. */
export interface JobRoute {
  channel: string | null;
  threadTs: string | null;
  /** The tenant to post as (selects the workspace credentials). Always set by `route()`; optional only
   *  so in-memory test fixtures (fake surface ignores it) can omit it. */
  orgId?: string;
}

/**
 * W4 — the DRIVER's persistence. The single place the thread driver reads/writes the thread + step
 * rows (and resolves the decision record + thread route) on the 'app' connection. The THREAD is the build
 * unit (the former `jobs` layer is folded into it), so the "job" methods here operate on the thread row.
 * Keeps `ThreadDriver` a legible pipeline that speaks DOMAIN shapes (`Thread`, `Step`) — this maps
 * them to/from rows and owns the explicit, resumable `status`/`step` transitions.
 *
 * The brain (W3) already wrote the high-level thread BRIEFS (`pending`, no plan). This fills the
 * just-in-time detail: the thread `plan`, its step rows, and the status cursors the driver re-enters
 * at on restart. Zero v1 imports.
 */
@Injectable()
export class DriverStoreService {
  constructor(
    @InjectRepository(JobEntity, DB_CONNECTION)
    private readonly jobs: Repository<JobEntity>,
    @InjectRepository(ThreadEntity, DB_CONNECTION)
    private readonly threads: Repository<ThreadEntity>,
    @InjectRepository(StepEntity, DB_CONNECTION)
    private readonly steps: Repository<StepEntity>,
    @InjectRepository(DecisionRecordEntity, DB_CONNECTION)
    private readonly records: Repository<DecisionRecordEntity>,
    @InjectRepository(MessageEntity, DB_CONNECTION)
    private readonly messages: Repository<MessageEntity>,
    @InjectRepository(CodexReviewEntity, DB_CONNECTION)
    private readonly codexReviews: Repository<CodexReviewEntity>,
    @InjectDataSource(DB_CONNECTION)
    private readonly dataSource: DataSource,
  ) {}

  // ── operator-input cards (the orchestrate build turn's `request_operator_input`) ─────────────────
  // A build turn can pause mid-orchestration and ask the operator a free-text question. It rides the SAME
  // durable question-card spine the brain uses — a `messages` card row keyed by `ts` + the denormalized
  // `threads.open_question_count` counter that lights "needs you" — tagged `origin:'build'` so the web
  // answer endpoint resolves it back to the DRIVER (which polls the card) instead of seeding a brain turn.
  // The job stays `running` throughout (so boot recovery still re-drives it); the card is the source of
  // truth, so a resumed/reattached turn just re-reads it. See ThreadDriver.operatorInputTool.

  /** The newest OPEN (unanswered) build-origin question card on this thread, or null. A resumed turn that
   *  re-issues its pending question reuses this instead of stacking a duplicate. */
  async findOpenOperatorInputCard(
    jobId: string,
  ): Promise<{ questionId: string; question: string } | null> {
    const rows = await this.messages.find({
      where: { job_id: jobId, kind: 'card' },
      order: { created_at: 'DESC' },
    });
    for (const row of rows) {
      const card = row.card as unknown as WebQuestionCard | undefined;
      if (
        card?.type === 'question_card' &&
        card.origin === 'build' &&
        card.answer == null
      ) {
        return { questionId: card.questionId, question: card.question };
      }
    }
    return null;
  }

  /** Open a build-origin question card (free-text) + bump `open_question_count` in ONE txn. Returns the
   *  stable `questionId` (the card row's `ts`) the driver then polls for an answer. */
  async openOperatorInputCard(
    jobId: string,
    question: string,
  ): Promise<{ questionId: string }> {
    const questionId = randomUUID();
    const card: WebQuestionCard = {
      type: 'question_card',
      origin: 'build',
      jobId,
      questionId,
      question,
      options: [],
      allowOther: true,
    };
    await this.dataSource.transaction(async (m) => {
      const messages = m.getRepository(MessageEntity);
      await messages.save(
        messages.create({
          job_id: jobId,
          author: 'Atlas',
          author_id: 'atlas',
          author_bot_id: 'atlas',
          text: question,
          kind: 'card',
          ts: questionId,
          card: card as unknown as Record<string, unknown>,
        }),
      );
      await m
        .getRepository(JobEntity)
        .createQueryBuilder()
        .update()
        .set({ open_question_count: () => 'open_question_count + 1' })
        .where('id = :jobId', { jobId })
        .execute();
    });
    return { questionId };
  }

  /** The operator's answer to a build-origin card, or null while still unanswered. */
  async readOperatorInputAnswer(
    jobId: string,
    questionId: string,
  ): Promise<string | null> {
    const row = await this.messages.findOne({
      where: { job_id: jobId, ts: questionId, kind: 'card' },
    });
    const card = row?.card as unknown as WebQuestionCard | undefined;
    return card?.type === 'question_card' ? (card.answer ?? null) : null;
  }

  /** Stamp a build-origin card `deliveredAt` once the driver has consumed the answer (so the boot
   *  answered-but-undelivered sweep never treats it as stranded). Jsonb-merge, like the brain's card
   *  lifecycle writes — no read-modify-write race. */
  async markOperatorInputDelivered(
    jobId: string,
    questionId: string,
  ): Promise<void> {
    await this.messages
      .createQueryBuilder()
      .update()
      .set({ card: () => 'card || :patch::jsonb' })
      .where('job_id = :jobId', { jobId })
      .andWhere('ts = :questionId', { questionId })
      .andWhere("kind = 'card'")
      .setParameter('patch', JSON.stringify({ deliveredAt: new Date().toISOString() }))
      .execute();
  }

  // ── thread (the build unit) ────────────────────────────────────────────────────────────────────

  /** Load one thread as the domain shape. */
  async loadJob(jobId: string): Promise<Job> {
    return toJob(
      await this.jobs.findOneOrFail({ where: { id: jobId } }),
    );
  }

  /** Every thread `running` AND not halted — the boot-reconciliation worklist. The `halt IS NULL` filter is
   *  the primary boot guard: a halted-but-`running` job must not be auto-re-driven (only retry/resume can). */
  async runningJobs(): Promise<Job[]> {
    const rows = await this.jobs.find({ where: { status: 'running', halt: IsNull() } });
    return rows.map(toJob);
  }

  async setJobStatus(jobId: string, status: JobStatus): Promise<void> {
    await this.jobs.update({ id: jobId }, { status });
  }

  /** Set the job's `activity` axis (see {@link JobActivity} / `deriveNeedsYou`) — the driver's build/review
   *  boundary writer, mirroring the brain's turn writer. */
  async setActivity(jobId: string, activity: JobActivity): Promise<void> {
    await this.jobs.update({ id: jobId }, { activity });
  }

  /** Record a phase-preserving job HALT (see {@link JobHalt}) — the status/phase is left untouched. Named
   *  JOB-level to stay distinct from {@link clearHalt} (the per-thread halt table). A halt means the build
   *  STOPPED, so `activity` is cleared to `idle` in the same write (a stale `build`/`master_review` must not
   *  mask the halt in `deriveNeedsYou`). */
  async setJobHalt(jobId: string, halt: JobHalt): Promise<void> {
    await this.jobs.update({ id: jobId }, { halt, activity: 'idle' });
  }

  /** Clear the phase-preserving job halt on operator re-engagement / a brain re-drive. */
  async clearJobHalt(jobId: string): Promise<void> {
    await this.jobs.update({ id: jobId }, { halt: null });
  }

  /** Record the feature branch all threads stack on (set once, when the sandbox is cut). */
  async setFeatureBranch(jobId: string, branch: string): Promise<void> {
    await this.jobs.update({ id: jobId }, { feature_branch: branch });
  }

  /**
   * Record the OBSERVED live branch the sandbox HEAD is on (sampled from the agent's git activity).
   * Null = detached/unknown; callers should skip the write on null to preserve the last-known branch.
   */
  async setCurrentBranch(jobId: string, branch: string | null): Promise<void> {
    await this.jobs.update({ id: jobId }, { current_branch: branch });
  }

  // ── ship-review gate (the terminal human gate: reviewed diff → operator clicks "Ship it" → PR) ────────

  /**
   * PARK the job at the ship-review gate in one txn: flip `running → awaiting_ship_review`, clear activity
   * to `idle`, and post the durable "Ship it" card. The status flip is CONDITIONAL on `running`, so it's
   * the single-park guard — a concurrent drive (or a re-drive) that finds the job already parked affects 0
   * rows and skips the card, returning false. Returns whether THIS caller parked it.
   */
  async parkForShipReview(
    jobId: string,
    card: Record<string, unknown>,
    summary: string,
  ): Promise<boolean> {
    return this.dataSource.transaction(async (m) => {
      const res = await m
        .getRepository(JobEntity)
        .createQueryBuilder()
        .update(JobEntity)
        .set({ status: 'awaiting_ship_review', activity: 'idle' })
        .where('id = :jobId', { jobId })
        .andWhere("status = 'running'")
        .execute();
      if ((res.affected ?? 0) === 0) return false;
      const messages = m.getRepository(MessageEntity);
      await messages.save(
        messages.create({
          job_id: jobId,
          author: 'Atlas',
          author_id: 'atlas',
          author_bot_id: 'atlas',
          text: summary,
          kind: 'card',
          ts: `ship-review:${jobId}`,
          card,
        }),
      );
      return true;
    });
  }

  /**
   * Record the ship-review APPROVAL (the "Ship it" click): stamp `ship_review_approved_at` and flip
   * `awaiting_ship_review → running` so the driver re-drives and re-reaches `finalizeBuild`. CONDITIONAL on
   * `awaiting_ship_review` — the idempotency guard, so a stale/double click (or one racing the live path) is
   * a no-op. Returns whether it acted.
   */
  async approveShip(jobId: string): Promise<boolean> {
    const res = await this.jobs
      .createQueryBuilder()
      .update(JobEntity)
      .set({ ship_review_approved_at: () => 'now()', status: 'running' })
      .where('id = :jobId', { jobId })
      .andWhere("status = 'awaiting_ship_review'")
      .execute();
    return (res.affected ?? 0) > 0;
  }

  /** Retract the ship-review gate back to `amending` (Atlas `withdraw_ship` tool OR the manual
   *  "Amend build" click). CONDITIONAL on `awaiting_ship_review` — single-winner vs a racing
   *  "Ship it" click; a stale/double retract is a no-op. Does NOT touch `ship_review_approved_at`
   *  (already null here) nor the decision record (the plan was approved — nothing to supersede).
   *  Also neutralizes EVERY still-actionable durable ship card so its inline "Ship it" button can't
   *  be clicked when the gate re-arms. */
  async retractShip(jobId: string): Promise<boolean> {
    return this.dataSource.transaction(async (m) => {
      const res = await m
        .getRepository(JobEntity)
        .createQueryBuilder()
        .update(JobEntity)
        .set({ status: 'amending', activity: 'idle' })
        .where('id = :jobId', { jobId })
        .andWhere("status = 'awaiting_ship_review'")
        .execute();
      if ((res.affected ?? 0) === 0) return false;
      const messages = m.getRepository(MessageEntity);
      const rows = await messages.find({
        where: { job_id: jobId, ts: `ship-review:${jobId}`, kind: 'card' },
      });
      for (const row of rows) {
        const card = row.card as Record<string, unknown> | null;
        if (card?.['type'] !== 'approval_card') continue;
        const title = String(card?.['title'] ?? 'Ship review');
        row.card = webVerdictCard(
          jobId,
          title,
          'retracted',
          '↩︎ Retracted — amending the build.',
        ) as unknown as Record<string, unknown>;
        await messages.save(row);
      }
      return true;
    });
  }

  /** Clear the ship-review approval marker so the NEXT build cycle re-gates. Called when a fresh build is
   *  dispatched (a new plan approval) — a re-drive after ship-approval must NOT clear it. */
  async clearShipApproval(jobId: string): Promise<void> {
    await this.jobs.update({ id: jobId }, { ship_review_approved_at: null });
  }

  /** Record the opened PR (url + number) + flip the thread to its terminal `done`. */
  async setPrReady(
    jobId: string,
    prUrl: string,
    prNumber?: number,
  ): Promise<void> {
    await this.jobs.update(
      { id: jobId },
      {
        pr_url: prUrl,
        ...(prNumber != null ? { pr_number: prNumber } : {}),
        status: 'done',
        activity: 'idle',
        // Latch the PR lifecycle to `open` HERE (not on a later reconcile) so the sidebar shows the
        // pull-request glyph the moment the PR is recorded — the reap-timer reconcile is up to 30 min away.
        pr_state: 'open',
      },
    );
  }

  // ── decision record ────────────────────────────────────────────────────────────────────────────

  /** The locked decision record for a thread — the planner + gate's grounding. Null if none. */
  async decisionRecord(
    decisionRecordId: string | null,
  ): Promise<DecisionRecord | null> {
    if (!decisionRecordId) return null;
    const row = await this.records.findOne({ where: { id: decisionRecordId } });
    return row ? toRecord(row) : null;
  }

  // ── threads ─────────────────────────────────────────────────────────────────────────────────

  /** The thread's threads in execution order (ORDER BY ordinal). */
  async threadsForJob(jobId: string): Promise<DriverThread[]> {
    const rows = await this.threads.find({
      where: { job_id: jobId },
      order: { ordinal: 'ASC' },
    });
    return rows.map(toThread);
  }

  async setThreadStatus(threadId: string, status: ThreadStatus): Promise<void> {
    await this.threads.update({ id: threadId }, { status });
  }

  async setThreadCondition(threadId: string, condition: ThreadCondition): Promise<void> {
    await this.threads.update({ id: threadId }, { condition });
  }

  /**
   * SET-ONCE the thread's start HEAD and return the AUTHORITATIVE value. The conditional update (`start_sha
   * IS NULL`) makes the first writer win, so a concurrent/resumed drive never overwrites the base; the
   * read-back then returns whatever actually landed so every drive converges on the same `start_sha..HEAD`
   * review range. Idempotent — a second call with the row already set is a no-op returning the stored sha.
   */
  async ensureThreadStartSha(threadId: string, candidate: string): Promise<string> {
    await this.threads.update({ id: threadId, start_sha: IsNull() }, { start_sha: candidate });
    const row = await this.threads.findOne({ where: { id: threadId } });
    return row?.start_sha ?? candidate;
  }

  /**
   * The newest recorded main-agent context occupancy for a build step's session — the durable backstop the
   * Leg-rotation gate reads at batch boundaries and on restart, when there is no live in-turn `usage` signal.
   * Reads `turn_stats` (where a builder turn's per-call occupancy is projected, keyed by `step_id`); returns
   * the most recent row that actually carries a context-token count.
   *
   * POSITIVE-SIGNAL ONLY: a null return (no row yet, or the SDK surfaced no occupancy — e.g. a Codex turn)
   * means the caller must NOT rotate. This polarity is deliberately INVERTED vs the brain's compaction gate
   * (`latestBrainOccupancy`, which compacts on unknown occupancy): a builder never rotates an unknown turn.
   */
  async latestStepOccupancy(
    stepId: string,
  ): Promise<{ contextTokens: number | null; contextLimit: number | null } | null> {
    const rows: Array<{ context_tokens: number | null; context_limit: number | null }> =
      await this.dataSource.query(
        `SELECT context_tokens, context_limit FROM turn_stats
           WHERE step_id = $1 AND context_tokens IS NOT NULL
           ORDER BY created_at DESC
           LIMIT 1`,
        [stepId],
      );
    const row = rows[0];
    if (!row) return null;
    return { contextTokens: row.context_tokens ?? null, contextLimit: row.context_limit ?? null };
  }

  // ── Leg rotation (context-rot mitigation: one build thread → many sequential engine sessions) ────────

  /**
   * Record/refresh the CURRENT (active) Leg row for a thread's anchor step — a `build_legs` projection used
   * by the UI. Idempotent upsert keyed by (thread_id, ordinal=leg_ordinal): the first call (leg 1) inserts it,
   * later calls refresh the live session id + peak occupancy. Safe to call after every batch turn; never
   * touches resume-critical state (that lives on the step). No-op-safe if the anchor step is gone.
   */
  async recordActiveLeg(
    anchorStepId: string,
    sessionId: string | null,
    contextTokensPeak?: number | null,
  ): Promise<void> {
    const step = await this.steps.findOne({ where: { id: anchorStepId } });
    if (!step) return;
    const legs = this.dataSource.getRepository(BuildLegEntity);
    const existing = await legs.findOne({
      where: { thread_id: step.thread_id, ordinal: step.leg_ordinal },
    });
    if (existing) {
      await legs.update(
        { id: existing.id },
        {
          session_id: sessionId,
          ...(contextTokensPeak != null
            ? { context_tokens_peak: Math.max(existing.context_tokens_peak ?? 0, contextTokensPeak) }
            : {}),
        },
      );
      return;
    }
    await legs.save(
      legs.create({
        org_id: step.org_id,
        job_id: step.job_id,
        thread_id: step.thread_id,
        ordinal: step.leg_ordinal,
        session_id: sessionId,
        status: 'active',
        context_tokens_peak: contextTokensPeak ?? null,
      }),
    );
  }

  /**
   * Persist a VISIBLE harness row into a BUILD thread's transcript — the driver analog of the brain's
   * `recordSystemChunk`, tagged for the build lane. `meta.phaseId` (the anchor step id) makes the web's
   * build-transcript filter pick it up, and `meta.legOrdinal` slices it to the right Leg (each Leg = its own
   * thread node). Insert-once by `meta.chunkKey` so a re-drive / reattach can't duplicate it. System-authored
   * (`author_bot_id: null`, NOT the operator, NOT Atlas). Used for the Leg-rotation nudges (`system_reminder`)
   * and the handoff + continuation-seed rows (`system_notice`).
   */
  async recordBuildSystemChunk(input: {
    jobId: string;
    phaseId: string;
    legOrdinal: number;
    kind: 'system_notice' | 'system_reminder';
    text: string;
    chunkKey: string;
    reminderKind?: string;
  }): Promise<void> {
    const dup = await this.messages
      .createQueryBuilder('m')
      .where('m.job_id = :jobId', { jobId: input.jobId })
      .andWhere('m.meta @> :key::jsonb', { key: JSON.stringify({ chunkKey: input.chunkKey }) })
      .getCount();
    if (dup > 0) return;
    await this.messages.save(
      this.messages.create({
        job_id: input.jobId,
        author: 'System',
        author_id: 'U-SYSTEM',
        author_bot_id: null,
        text: input.text,
        kind: 'chat',
        meta: {
          source: input.kind,
          phaseId: input.phaseId,
          legOrdinal: input.legOrdinal,
          chunkKey: input.chunkKey,
          ...(input.reminderKind ? { reminderKind: input.reminderKind } : {}),
        },
      }),
    );
  }

  /**
   * ROTATE the anchor step's build session in ONE transaction (the analog of the brain's `completeCompaction`,
   * applied to a build step). Reads the current fat session off the step, then atomically:
   *   • sets `steps.rotating_session_id` = the fat session (abandon marker + restart signal),
   *   • NULLs `steps.session_id` (so the next turn starts FRESH — resume reads null),
   *   • stores `steps.pending_leg_seed` = the seed (folded into the next Leg's task),
   *   • increments `steps.leg_ordinal`,
   *   • closes the current `build_legs` row (status='rotated', handoff_md, peak, ended_at),
   *   • opens the next `build_legs` row (ordinal+1, status='active').
   * `commit_sha` / `batch_ordinal` are DELIBERATELY untouched — a rotation must never look like a committed
   * batch to the atomic-resume fast-forward. Returns null (no-op) when there is no live session to rotate.
   */
  async completeLegRotation(input: {
    anchorStepId: string;
    handoff: string;
    seed: string;
    contextTokensPeak?: number | null;
  }): Promise<{ fromLeg: number; toLeg: number; abandonedSessionId: string } | null> {
    return this.dataSource.transaction(async (m) => {
      const steps = m.getRepository(StepEntity);
      const legs = m.getRepository(BuildLegEntity);
      const step = await steps.findOne({ where: { id: input.anchorStepId } });
      if (!step || !step.session_id) return null; // nothing live to rotate
      const abandonedSessionId = step.session_id;
      const fromLeg = step.leg_ordinal;
      const toLeg = fromLeg + 1;

      await steps.update(
        { id: step.id },
        {
          rotating_session_id: abandonedSessionId,
          session_id: null,
          pending_leg_seed: input.seed,
          leg_ordinal: toLeg,
        },
      );

      // Close the outgoing Leg's projection row (upsert — create it if leg 1 never got a live row).
      const current = await legs.findOne({ where: { thread_id: step.thread_id, ordinal: fromLeg } });
      const closed = {
        status: 'rotated',
        handoff_md: input.handoff,
        session_id: abandonedSessionId,
        ended_at: new Date(),
        ...(input.contextTokensPeak != null ? { context_tokens_peak: input.contextTokensPeak } : {}),
      };
      if (current) await legs.update({ id: current.id }, closed);
      else
        await legs.save(
          legs.create({
            org_id: step.org_id,
            job_id: step.job_id,
            thread_id: step.thread_id,
            ordinal: fromLeg,
            ...closed,
          }),
        );

      // Open the incoming Leg (session id fills in when the fresh turn is born).
      await legs.save(
        legs.create({
          org_id: step.org_id,
          job_id: step.job_id,
          thread_id: step.thread_id,
          ordinal: toLeg,
          status: 'active',
          session_id: null,
        }),
      );

      return { fromLeg, toLeg, abandonedSessionId };
    });
  }

  /** Read the anchor step's pending Leg seed (the handoff folded into the next turn's task), or null. */
  async getPendingLegSeed(anchorStepId: string): Promise<string | null> {
    const step = await this.steps.findOne({ where: { id: anchorStepId } });
    return step?.pending_leg_seed ?? null;
  }

  /** All Legs of a thread, oldest first — the read model behind the UI's per-Leg rows + handoff pills. */
  async getLegs(threadId: string): Promise<BuildLegEntity[]> {
    return this.dataSource
      .getRepository(BuildLegEntity)
      .find({ where: { thread_id: threadId }, order: { ordinal: 'ASC' } });
  }

  /** Every Leg of a JOB, oldest first — the batched read `getPipelineState` groups by thread (avoids N+1). */
  async getLegsForJob(jobId: string): Promise<BuildLegEntity[]> {
    return this.dataSource
      .getRepository(BuildLegEntity)
      .find({ where: { job_id: jobId }, order: { ordinal: 'ASC' } });
  }

  /** A thread's durable LLM-authored task list (`threads.tasks`) — read when rotating so the fresh Leg's seed
   *  carries the open/in-progress items (the SDK's in-memory todo dies with the session; this persists). */
  async getThreadTasks(threadId: string): Promise<TaskItem[]> {
    const row = await this.threads.findOne({ where: { id: threadId }, select: { id: true, tasks: true } });
    return Array.isArray(row?.tasks) ? row!.tasks : [];
  }

  /** Live single-thread read (not the run-start snapshot). Used to detect a thread a concurrent/stale drive
   *  has already finished, so we don't re-execute or re-review it. */
  async getThread(threadId: string): Promise<DriverThread | null> {
    const row = await this.threads.findOne({ where: { id: threadId } });
    return row ? toThread(row) : null;
  }

  /** Persist the just-in-time plan prose + the prior thread's handoff onto the thread. */
  async setThreadPlan(
    threadId: string,
    plan: string,
    handoffIn: string | null,
  ): Promise<void> {
    await this.threads.update({ id: threadId }, { plan, handoff_in: handoffIn });
  }

  /**
   * Persist the thread's repo-orientation cheat-sheet (captured by the plan turn). Kept separate from
   * {@link setThreadPlan} so a later plan-prose rewrite (the review→revise pass) can't clobber it.
   */
  async setThreadOrientation(
    threadId: string,
    orientation: string,
  ): Promise<void> {
    await this.threads.update({ id: threadId }, { orientation });
  }

  /** Record the thread's handoff note for the next thread (set when the thread is done). */
  async setThreadHandoffOut(threadId: string, handoffOut: string): Promise<void> {
    await this.threads.update({ id: threadId }, { handoff_out: handoffOut });
  }

  /** Append an inline out-of-scope fix to `threads.deviations` (from the builder's `record_deviation` tool).
   *  Idempotent on note text so a re-driven turn re-recording the same fix doesn't duplicate it — the durable
   *  source behind the `/context/generated/deviations.md` projection. Single host writer per thread, so a plain
   *  read-modify-write is race-free. */
  async recordDeviation(threadId: string, entry: DeviationEntry): Promise<void> {
    const row = await this.threads.findOne({
      where: { id: threadId },
      select: { id: true, deviations: true },
    });
    if (!row) return;
    const current = Array.isArray(row.deviations) ? row.deviations : [];
    if (current.some((d) => d.note.trim() === entry.note.trim())) return;
    await this.threads.update({ id: threadId }, { deviations: [...current, entry] });
  }

  /** Every thread of a job that recorded at least one inline deviation, ordered for the `deviations.md`
   *  projection (which re-renders the whole file from this — never appends). */
  async getJobDeviations(
    jobId: string,
  ): Promise<{ ordinal: number; brief: string; deviations: DeviationEntry[] }[]> {
    const rows = await this.threads.find({
      where: { job_id: jobId },
      select: { id: true, ordinal: true, brief: true, deviations: true },
      order: { ordinal: 'ASC' },
    });
    return rows
      .map((r) => ({
        ordinal: r.ordinal,
        brief: r.brief,
        deviations: Array.isArray(r.deviations) ? r.deviations : [],
      }))
      .filter((r) => r.deviations.length > 0);
  }

  // ── typed terminal record (ADR 0004: the thread ASSERTS its outcome; the driver reads it) ──────────

  /** Persist the orchestrator's typed terminal assertion (from `complete_thread`/`block_thread`). */
  async recordThreadTermination(
    threadId: string,
    record: ThreadTerminalRecord,
  ): Promise<void> {
    await this.threads.update({ id: threadId }, { terminal_record: record });
  }

  /** Clear any prior terminal record before a (re-)drive so a stale assertion from an earlier attempt is
   *  never misread as this turn's outcome. Called at thread start. */
  async clearTerminalRecord(threadId: string): Promise<void> {
    await this.threads.update({ id: threadId }, { terminal_record: null });
  }

  /** Read the thread's terminal record FRESH from the DB (the tool wrote it mid-turn; the in-memory thread
   *  object is stale). Null when the turn never asserted an outcome → the driver treats it as `incomplete`. */
  async getTerminalRecord(threadId: string): Promise<ThreadTerminalRecord | null> {
    const row = await this.threads.findOne({
      where: { id: threadId },
      select: { id: true, terminal_record: true },
    });
    return row?.terminal_record ?? null;
  }

  // ── Phase 3 halt-wake + bounded autonomous fix (ADR 0004 rider 4) ──────────────────────────────

  /** The owning job id of a thread (or null if the thread is gone) — the redrive seam validates that a
   *  model-supplied `threadId` actually belongs to the current job before mutating it (never clear another
   *  job's thread on a hallucinated/stale id). */
  async threadJobId(threadId: string): Promise<string | null> {
    const row = await this.threads.findOne({
      where: { id: threadId },
      select: { id: true, job_id: true },
    });
    return row?.job_id ?? null;
  }

  /** Mark a halted thread as OWED a brain wake (set by `haltJob` the moment a thread halts non-`done`).
   *  `outcome` is the resolved `ThreadOutcome`. Leaves `halt_waked_at` null so the wake is owed. */
  async setHaltOwed(
    threadId: string,
    outcome: 'blocked' | 'incomplete' | 'failed',
  ): Promise<void> {
    await this.threads.update(
      { id: threadId },
      { halt_outcome: outcome, halt_waked_at: null },
    );
  }

  /** Threads whose halt is owed a brain wake (`halt_outcome` set, not yet waked). Optionally scoped to one
   *  job. Returns the minimal shape the wake path needs: ids + the generation token (`halt_fix_attempts`)
   *  the wake-stamp CAS keys on. */
  async threadsAwaitingHaltWake(jobId?: string): Promise<
    {
      jobId: string;
      threadId: string;
      gen: number;
      outcome: 'blocked' | 'incomplete' | 'failed';
    }[]
  > {
    const qb = this.threads
      .createQueryBuilder('t')
      .select(['t.id', 't.job_id', 't.halt_fix_attempts', 't.halt_outcome'])
      .where('t.halt_outcome IS NOT NULL')
      .andWhere('t.halt_waked_at IS NULL');
    if (jobId) qb.andWhere('t.job_id = :jobId', { jobId });
    const rows = await qb.getMany();
    return rows.map((r) => ({
      jobId: r.job_id,
      threadId: r.id,
      gen: r.halt_fix_attempts,
      outcome: r.halt_outcome as 'blocked' | 'incomplete' | 'failed',
    }));
  }

  /** Stamp the wake delivered — a GENERATION-KEYED CAS (ADR 0004 Phase 3): stamp only if `halt_fix_attempts`
   *  still equals the `gen` captured when the wake fired (no re-drive happened mid-wake) and the halt is still
   *  owed + un-waked. A stale wake completing after a re-drive matches zero rows, so it can never clobber the
   *  re-drive's re-armed (null) marker and silence a fresh halt's wake. */
  async markHaltWaked(threadId: string, gen: number): Promise<void> {
    await this.threads
      .createQueryBuilder()
      .update(ThreadEntity)
      .set({ halt_waked_at: () => 'now()' })
      .where('id = :threadId', { threadId })
      .andWhere('halt_fix_attempts = :gen', { gen })
      .andWhere('halt_waked_at IS NULL')
      .andWhere('halt_outcome IS NOT NULL')
      .execute();
  }

  // ── Completion-wake (decision d1) — mirrors the halt trio above, no generation CAS ─────────────

  /** Mark a `done` thread as OWED a brain wake — `'final'` (whole build parked at ship gate) or `'notable'`
   *  (done-with-gaps). Idempotent: a repeat call re-asserts the same owed row. */
  async setDoneWakeOwed(threadId: string, reason: 'final' | 'notable'): Promise<void> {
    await this.threads.update(
      { id: threadId },
      { done_wake_owed: true, done_wake_reason: reason, done_waked_at: null },
    );
  }

  /** Threads whose completion is owed a brain wake (`done_wake_owed`, not yet waked). Optionally scoped to
   *  one job. Mirrors `threadsAwaitingHaltWake`'s shape (no `gen` — a `done` thread is never re-driven). */
  async threadsAwaitingDoneWake(
    jobId?: string,
  ): Promise<{ jobId: string; threadId: string; reason: 'final' | 'notable' }[]> {
    const qb = this.threads
      .createQueryBuilder('t')
      .select(['t.id', 't.job_id', 't.done_wake_reason'])
      .where('t.done_wake_owed IS TRUE')
      .andWhere('t.done_waked_at IS NULL');
    if (jobId) qb.andWhere('t.job_id = :jobId', { jobId });
    const rows = await qb.getMany();
    return rows.map((r) => ({
      jobId: r.job_id,
      threadId: r.id,
      reason: r.done_wake_reason as 'final' | 'notable',
    }));
  }

  /** Stamp the completion wake delivered and clear the owed flag — idempotent (keyed on `done_wake_owed`
   *  still true + `done_waked_at` still null, so a repeat/racing call matches zero rows). */
  async markDoneWaked(threadId: string): Promise<void> {
    await this.threads
      .createQueryBuilder()
      .update(ThreadEntity)
      .set({ done_waked_at: () => 'now()', done_wake_owed: false })
      .where('id = :threadId', { threadId })
      .andWhere('done_wake_owed IS TRUE')
      .andWhere('done_waked_at IS NULL')
      .execute();
  }

  /** The job's `master_review` thread id — the carrier for the `'final'` completion wake — or null if the
   *  job has none (yet). */
  async masterReviewThreadId(jobId: string): Promise<string | null> {
    const row = await this.threads.findOne({
      where: { job_id: jobId, kind: 'master_review' },
      select: { id: true },
    });
    return row?.id ?? null;
  }

  /** Clear the halt signal on a re-drive so a FRESH block re-arms a fresh wake (both the owed flag and the
   *  dedup marker). The `halt_fix_attempts` budget is intentionally NOT cleared (it's a lifetime counter). */
  async clearHalt(threadId: string): Promise<void> {
    await this.threads.update(
      { id: threadId },
      { halt_outcome: null, halt_waked_at: null },
    );
  }

  /** CAS-claim one autonomous re-drive attempt: atomically increment `halt_fix_attempts` iff still below
   *  `cap`. Returns `{ ok:true, used }` when a slot was claimed, else `{ ok:false, used:cap }` (exhausted).
   *  The compare-and-swap makes a double-fired wake safe — two concurrent claims can't both pass the cap. */
  async claimHaltFixAttempt(
    threadId: string,
    cap: number,
  ): Promise<{ ok: boolean; used: number }> {
    const res = await this.threads
      .createQueryBuilder()
      .update(ThreadEntity)
      .set({ halt_fix_attempts: () => 'halt_fix_attempts + 1' })
      .where('id = :threadId', { threadId })
      .andWhere('halt_fix_attempts < :cap', { cap })
      .returning('halt_fix_attempts')
      .execute();
    const used = res.raw?.[0]?.halt_fix_attempts as number | undefined;
    return used != null ? { ok: true, used } : { ok: false, used: cap };
  }

  /** The thread's spent autonomous re-drive budget (0 if unset). Read by `haltJob` to decide whether a
   *  `blocked` thread still has brain-retry budget (keep the job running + wake) or is spent (rest the job). */
  async haltFixAttempts(threadId: string): Promise<number> {
    const row = await this.threads.findOne({
      where: { id: threadId },
      select: { id: true, halt_fix_attempts: true },
    });
    return row?.halt_fix_attempts ?? 0;
  }

  /** OPERATOR RE-ARM (ADR 0004 rider 4): reset the autonomous re-drive budget for a job's spent threads so a
   *  human re-engagement (`resumePaused`/`retry`) grants Atlas a fresh set of attempts. The counter is a
   *  LIFETIME budget for AUTONOMOUS loops — only an explicit operator action re-arms it (never boot-resume),
   *  so the halt loop can't self-perpetuate. Returns how many threads were re-armed. */
  async rearmHaltedThreads(jobId: string): Promise<number> {
    const res = await this.threads
      .createQueryBuilder()
      .update(ThreadEntity)
      .set({ halt_fix_attempts: 0 })
      .where('job_id = :jobId', { jobId })
      .andWhere('halt_fix_attempts > 0')
      .execute();
    return res.affected ?? 0;
  }

  // ── review children (post-build review fan-out as real child threads) ──────────────────────────
  // A builder's post-build review is N `review_lens` rows + 1 `post_review` row, each a first-class
  // `threads` child (parent_thread_id = builder). Each lens is its OWN row with its OWN status +
  // `review_findings` — nothing shared to clobber, so the torn-jsonb "stuck at reviewing" lost-update race
  // is gone structurally. The `post_review` row reads the full findings off its sibling lens rows.

  /**
   * Materialize a builder's review children (idempotent). If children already exist (a resume, or a
   * concurrent drive won the race), returns them untouched; else inserts the given child specs as `pending`
   * rows, gap-numbered per-parent. On a unique-index conflict (a concurrent drive inserted first — the
   * `(job_id, parent_thread_id, ordinal)` index rejects the dup) it re-reads rather than throwing.
   */
  async materializeReviewChildren(
    parent: { id: string; jobId: string; orgId: string },
    childSpecs: Array<{ kind: string; brief: string; config: Record<string, unknown> }>,
  ): Promise<ReviewChildThread[]> {
    const existing = await this.reviewChildren(parent.id);
    if (existing.length > 0) return existing;
    const rows = childSpecs.map((c, i) =>
      this.threads.create({
        job_id: parent.jobId,
        org_id: parent.orgId,
        parent_thread_id: parent.id,
        kind: c.kind,
        ordinal: (i + 1) * ORDINAL_GAP,
        brief: c.brief,
        config: c.config,
        status: 'pending',
      }),
    );
    try {
      await this.threads.save(rows);
    } catch (err) {
      const reread = await this.reviewChildren(parent.id);
      if (reread.length > 0) return reread;
      throw err;
    }
    return this.reviewChildren(parent.id);
  }

  /** A parent builder's review children (review_lens rows + the post_review row), in ordinal order. */
  async reviewChildren(parentId: string): Promise<ReviewChildThread[]> {
    const rows = await this.threads.find({
      where: { parent_thread_id: parentId },
      order: { ordinal: 'ASC' },
    });
    return rows.map(toReviewChild);
  }

  /** Persist the FULL `ReviewFinding[]` a `review_lens` produced onto its own row — the post_review child
   *  reads the complete findings off its siblings (dedupe + severity-filter → the fix prompt). */
  async setThreadReviewFindings(
    threadId: string,
    findings: ReviewFinding[],
  ): Promise<void> {
    await this.threads.update({ id: threadId }, { review_findings: findings });
  }

  // ── steps ───────────────────────────────────────────────────────────────────────────────────

  /** A thread's steps in execution order. */
  async stepsForThread(threadId: string): Promise<Step[]> {
    const rows = await this.steps.find({
      where: { thread_id: threadId },
      order: { ordinal: 'ASC' },
    });
    return rows.map(toStep);
  }

  /**
   * The AUTHORITATIVE transcript anchor for a thread — the engine `sessionId` (+ Leg ordinal) the wake hands
   * the brain to read the halted/completed lane's raw JSONL (`atlas-tx show <sessionId>`). Resolved from the
   * most-recent `build_legs` row with a non-null `session_id` (preferred — carries the Leg ordinal), else the
   * latest `steps.session_id`. Read from steps/legs — which exist for EVERY thread that ran a turn — NOT from
   * `terminal_record`, so it works even for an `incomplete` halt whose record is null. The host has ground
   * truth here; a builder-written value is never trusted. `undefined` only when the thread never got a session
   * (e.g. halted in provisioning).
   */
  async resolveSessionAnchor(threadId: string): Promise<SessionAnchor | undefined> {
    const legs = await this.getLegs(threadId);
    const legWithSession = [...legs]
      .reverse()
      .find((l) => l.session_id != null);
    if (legWithSession?.session_id) {
      return {
        sessionId: legWithSession.session_id,
        legOrdinal: legWithSession.ordinal,
      };
    }
    const steps = await this.stepsForThread(threadId);
    const stepWithSession = [...steps]
      .reverse()
      .find((s) => s.sessionId != null);
    if (stepWithSession?.sessionId) {
      return {
        sessionId: stepWithSession.sessionId,
        legOrdinal: stepWithSession.legOrdinal,
      };
    }
    return undefined;
  }

  /**
   * Lock a thread's steps: persist the planned step list as `steps` rows (gap-numbered,
   * `pending`/step `build`). Idempotent across a resume — if rows already exist (the plan locked before
   * the restart) the existing rows are returned untouched, so steps never double-create.
   */
  async lockSteps(thread: DriverThread, planned: PlannedStep[]): Promise<Step[]> {
    const existing = await this.stepsForThread(thread.id);
    if (existing.length > 0) return existing;
    const rows = planned.map((p, i) =>
      this.steps.create({
        thread_id: thread.id,
        job_id: thread.jobId,
        org_id: thread.orgId,
        ordinal: (i + 1) * ORDINAL_GAP,
        title: p.title,
        brief: p.brief,
        stage: 'build',
        status: 'pending',
      }),
    );
    await this.steps.save(rows);
    return rows.map(toStep);
  }

  /** Advance a step's explicit cursor (`step` + `status`) — the resumable transition. */
  async setStepState(
    stepId: string,
    stage: string,
    status: StepStatus,
  ): Promise<void> {
    await this.steps.update({ id: stepId }, { stage, status });
  }

  /** Stamp the batch ANCHOR step's commit marker the instant its batch commits — written BEFORE the
   *  per-step done writes so a crash in between fast-forwards on resume instead of re-running (#6). */
  async setStepCommit(stepId: string, commitSha: string): Promise<void> {
    await this.steps.update({ id: stepId }, { commit_sha: commitSha });
  }

  /**
   * Persist the batch grouping for a thread's steps — the resumable batching cursor. Assigned ONCE,
   * the first time a thread executes (all its steps have null `batch_ordinal`); after this a restart
   * reads the stored ordinals and re-groups identically, so a resumed engine session keeps the SAME
   * batch membership (no second `batchSteps` call, no drift). Each tuple is `[stepId, batchOrdinal]`.
   */
  async setBatchOrdinals(assignments: Array<[string, number]>): Promise<void> {
    for (const [stepId, batchOrdinal] of assignments) {
      await this.steps.update({ id: stepId }, { batch_ordinal: batchOrdinal });
    }
  }

  // ── brain read helpers ───────────────────────────────────────────────────────────────────────

  /**
   * R3 — `get_pipeline_state` tool impl. Returns the current build + thread state for a thread, or
   * `{ status: 'no_job' }` if the thread hasn't entered the build lifecycle. Used by the in-sandbox
   * AgentSessionManager brain session.
   */
  async getPipelineState(jobId: string, orgId: string): Promise<unknown> {
    const thread = await this.jobs.findOne({
      where: { id: jobId, org_id: orgId },
    });
    if (!thread) return { status: 'no_job' };
    // An `open` job (chatting/planning, never entered the build lifecycle) has no pipeline — but its
    // brain can already be keeping a task list, and the navigator's Main row shows it. Ride the no_job
    // payload so the web isn't blind to it before a plan exists.
    if (thread.status === 'open') {
      return {
        status: 'no_job',
        mainTasks: Array.isArray(thread.main_tasks) ? thread.main_tasks : [],
        // The Main (brain) lane's pre-turn footer default — so a planning job shows "Opus 4.8" before
        // its first brain turn completes (no `turn_meta` to derive from yet).
        mainDefaultFooter: laneDefaultFooter('main'),
      };
    }
    const allThreads = await this.threads.find({
      where: { job_id: thread.id },
      order: { ordinal: 'ASC' },
    });
    // Split root threads (main/builder/master_review) from a builder's review children (review_lens /
    // post_review, `parent_thread_id` set). The top-level `threads` array is the ROOT rows; each builder's
    // `reviewAgents` is DERIVED from its review_lens child rows (each carries its own status + findings) —
    // no shared jsonb. (Step 5 rewrites the web to render the full tree from `(kind, parent_id)` directly;
    // this keeps the existing per-thread `reviewAgents` contract working until then.)
    const childrenByParent = new Map<string, ThreadEntity[]>();
    for (const t of allThreads) {
      if (t.parent_thread_id) {
        const list = childrenByParent.get(t.parent_thread_id) ?? [];
        list.push(t);
        childrenByParent.set(t.parent_thread_id, list);
      }
    }
    // The top-level `threads` array is the driver-EXECUTABLE roots (builder + master_review). `main` renders
    // as the navigator's always-first Main row (from `main_tasks`); `plan_review` renders as its own Codex
    // review row (below) — both from their own sources, so they're excluded from this build-lane list.
    const threads = allThreads.filter(
      (t) => t.parent_thread_id == null && isDriverExecutableKind(t.kind),
    );
    // The PLAN REVIEW as a first-class navigator row (the Codex review dialogue Main communicates with). It's
    // its own thread (`kind='plan_review'`), but its runtime + transcript live on the `codex-review:<jobId>`
    // lane + the `codex_reviews` row (the authoritative status). Surface it when EITHER exists (a new job has
    // the thread row; a job reviewed before plan_review became a row still has the codex_reviews row). The web
    // renders a row that opens the `codex-review:<jobId>` lane. Null → no review ran, no row.
    const planReviewThread = allThreads.find((t) => t.kind === 'plan_review') ?? null;
    const codexRow = await this.codexReviews
      .findOne({ where: { job_id: thread.id }, select: { id: true, status: true } })
      .catch(() => null);
    const planReview =
      codexRow || planReviewThread
        ? {
            status: codexRow?.status ?? planReviewThread?.status ?? 'reviewing',
            // The Codex-review lane's pre-turn footer default ("Codex · xHigh").
            defaultFooter: laneDefaultFooter('plan_review'),
          }
        : null;
    // All the thread's steps in one query (avoid N+1), grouped by thread for the nav folder tree.
    const steps = await this.steps.find({
      where: { job_id: thread.id },
      order: { ordinal: 'ASC' },
    });
    const stepsByThread = new Map<string, StepEntity[]>();
    for (const p of steps) {
      const list = stepsByThread.get(p.thread_id) ?? [];
      list.push(p);
      stepsByThread.set(p.thread_id, list);
    }
    // The thread's BUILD LEGS (context-rot rotation read model) — one query, grouped by thread. A thread with
    // no rotation has 0 rows (the UI shows a single implicit Leg); a rotated thread has one row per Leg with
    // the handoff pill text between them. Fetched all-at-once to avoid an N+1 across threads.
    const legs = await this.getLegsForJob(thread.id).catch(() => [] as BuildLegEntity[]);
    const legsByThread = new Map<string, BuildLegEntity[]>();
    for (const l of legs) {
      const list = legsByThread.get(l.thread_id) ?? [];
      list.push(l);
      legsByThread.set(l.thread_id, list);
    }
    return {
      jobId: thread.id,
      title: thread.title,
      kind: thread.kind,
      status: thread.status,
      halt: thread.halt ?? null,
      // Which build path was committed at approval: 'direct' (fast, brain-implemented) | 'plan' (driver) |
      // null (never approved). The navigator reads this to hide the plan-oriented empty-state placeholders
      // (build lanes / plan.md / generated docs) for a direct build, where they never apply.
      buildPath: thread.build_path ?? null,
      // The plan-review (Codex) thread's presence + live status — the navigator renders a dedicated row that
      // opens the `codex-review:<jobId>` lane. Null when no review has run.
      planReview,
      decisionRecordId: thread.decision_record_id,
      prUrl: thread.pr_url,
      prNumber: thread.pr_number,
      // Observed PR lifecycle (`open | merged | closed`) + merge-conflict signal — the SAME reconciler-owned
      // columns the sidebar's PR glyph reads. Surfaced here so the navigator's PR row mirrors the sidebar
      // instead of hardcoding "open" (it would otherwise show a stale green "open" after a merge/close).
      prState: thread.pr_state,
      prMergeable: thread.pr_mergeable,
      // The observed CI/CD aggregate for the PR head (`success|failure|pending|null`) — drives the
      // navigator PR-row CI glyph, kept fresh by the webhook CI-sync + the 30-min reconciler backstop.
      ciStatus: thread.ci_status,
      featureBranch: thread.feature_branch,
      // The OBSERVED live branch (what the agent's HEAD is actually on) — drives the navigator drift badge
      // when it diverges from the host-named featureBranch. Null until first sampled / on detached HEAD.
      currentBranch: thread.current_branch,
      baseBranch: thread.base_branch,
      // The Main brain session's own task list (folded from its `main`-lane task-tool calls) — the
      // navigator's Main row renders it. No fallback default (tasks are pure LLM output — there's no
      // fixed/expected set the way there is for review agents). The old job-level PR-review fields
      // (`reviewAgents`/`tasks`/`prReviewStatus`) are gone — master review is now a normal build thread.
      mainTasks: Array.isArray(thread.main_tasks) ? thread.main_tasks : [],
      // The Main (brain) lane's pre-turn footer default — the web renders Main from `mainTasks` (it's not in
      // the `threads` array), so it needs its own default carrier for the pre-first-turn footer.
      mainDefaultFooter: laneDefaultFooter('main'),
      threads: threads.map((s) => ({
        id: s.id,
        ordinal: s.ordinal,
        brief: s.brief,
        type: s.type,
        status: s.status,
        condition: s.condition,
        // The lane's pre-turn composer-footer default (`model · effort`), keyed off the thread's kind.
        defaultFooter: laneDefaultFooter(s.kind),
        // Derived from `kind` (the `is_master_review` column is gone) — the web keys "Master review"
        // rendering off this field. `kind` is also surfaced directly for the data-driven tree.
        kind: s.kind,
        isMasterReview: s.kind === 'master_review',
        hasPlan: s.plan != null,
        // The builder's review CHILD threads (review_lens × N + post_review) — each a first-class row with
        // its own status + findings + streaming lane. The web renders the review sub-tree directly from
        // these (bare child-thread nodes). A master-review thread has no children (it IS the review).
        children: pipelineReviewChildren(s, childrenByParent.get(s.id) ?? []),
        // The thread's own LLM-authored task list — no fallback default, same rationale as the job-level
        // field above.
        tasks: Array.isArray(s.tasks) ? s.tasks : [],
        // Build Legs (context-rot rotation): one navigable row per engine session, with the handoff pill each
        // rotated Leg authored. Empty for a thread that never rotated (the web renders a single implicit Leg).
        legs: pipelineLegs(legsByThread.get(s.id) ?? []),
        steps: mapBatchedSteps(stepsByThread.get(s.id) ?? []),
      })),
    };
  }

  /**
   * R3 — `get_decision_record` tool impl. Returns the current decision record for a thread (via the
   * thread's `decision_record_id`), or null. Used by the in-sandbox brain session.
   */
  async getDecisionRecord(jobId: string): Promise<unknown> {
    const thread = await this.jobs.findOne({ where: { id: jobId } });
    if (!thread?.decision_record_id) return null;
    const record = await this.records.findOne({
      where: { id: thread.decision_record_id },
    });
    if (!record) return null;
    return {
      id: record.id,
      status: record.status,
      overview: record.overview,
      decisions: record.decisions,
      threadTitles: record.thread_titles,
    };
  }

  // ── routing ──────────────────────────────────────────────────────────────────────────────────

  /** Resolve where to post a thread's chatter: the repo coordinate + the real thread id. */
  async route(thread: Job): Promise<JobRoute> {
    return { channel: thread.repoId, threadTs: thread.id, orgId: thread.orgId };
  }
}

/**
 * Map a thread's step rows for the `/pipeline` read model, resolving each step's BATCH so the web can find
 * the batch's transcript. A batch runs as ONE engine turn whose transcript is tagged with the ANCHOR step
 * id (the first/lowest-ordinal step in the batch), so a non-anchor step page must remap to `anchorStepId`
 * before filtering durable phase blocks / choosing the live `phase:<id>` lane. Steps not yet batched
 * (`batch_ordinal` null) anchor to themselves.
 */
function mapBatchedSteps(list: StepEntity[]): Array<{
  id: string;
  ordinal: number;
  title: string | null;
  brief: string;
  stage: string;
  status: string;
  batchOrdinal: number | null;
  anchorStepId: string;
  batchStepIds: string[];
}> {
  const anchorByBatch = new Map<number, string>();
  const idsByBatch = new Map<number, string[]>();
  for (const p of list) {
    if (p.batch_ordinal == null) continue;
    if (!anchorByBatch.has(p.batch_ordinal))
      anchorByBatch.set(p.batch_ordinal, p.id);
    const arr = idsByBatch.get(p.batch_ordinal) ?? [];
    arr.push(p.id);
    idsByBatch.set(p.batch_ordinal, arr);
  }
  return list.map((p) => ({
    id: p.id,
    ordinal: p.ordinal,
    title: p.title,
    brief: p.brief,
    stage: p.stage,
    status: p.status,
    batchOrdinal: p.batch_ordinal ?? null,
    anchorStepId:
      p.batch_ordinal != null
        ? (anchorByBatch.get(p.batch_ordinal) ?? p.id)
        : p.id,
    batchStepIds:
      p.batch_ordinal != null
        ? (idsByBatch.get(p.batch_ordinal) ?? [p.id])
        : [p.id],
  }));
}

// ── row ⇄ domain mappers ─────────────────────────────────────────────────────────────────────────

function toJob(row: JobEntity): Job {
  return {
    id: row.id,
    orgId: row.org_id,
    repoId: row.repo_id,
    origin: row.origin as Job['origin'],
    surfaceThreadRef: row.surface_thread_ref,
    title: row.title,
    baseBranch: row.base_branch,
    kind: row.kind as Job['kind'],
    status: row.status as JobStatus,
    activity: row.activity,
    halt: row.halt ?? null,
    decisionRecordId: row.decision_record_id,
    featureBranch: row.feature_branch,
    currentBranch: row.current_branch,
    prUrl: row.pr_url,
    prNumber: row.pr_number,
    shipReviewApprovedAt: row.ship_review_approved_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toThread(row: ThreadEntity): DriverThread {
  return {
    id: row.id,
    jobId: row.job_id,
    orgId: row.org_id,
    ordinal: row.ordinal,
    brief: row.brief,
    plan: row.plan,
    orientation: row.orientation,
    handoffIn: row.handoff_in,
    handoffOut: row.handoff_out,
    status: row.status as ThreadStatus,
    condition: (row.condition as ThreadCondition) ?? 'none',
    kind: row.kind,
    parentThreadId: row.parent_thread_id ?? null,
    startSha: row.start_sha ?? null,
  };
}

function toReviewChild(row: ThreadEntity): ReviewChildThread {
  return {
    id: row.id,
    kind: row.kind,
    brief: row.brief,
    ordinal: row.ordinal,
    config: (row.config as Record<string, unknown>) ?? {},
    status: row.status as ThreadStatus,
    condition: (row.condition as ThreadCondition) ?? 'none',
    reviewFindings: Array.isArray(row.review_findings) ? row.review_findings : null,
  };
}

/** The `/pipeline` wire shape of a builder's review child (a `review_lens` / `post_review`). */
interface PipelineReviewChild {
  id: string;
  kind: string;
  brief: string;
  status: string;
  condition: string;
  lensId?: string;
  findings: number | null;
  lane: string;
  /** The lane's pre-turn composer-footer default (`model · effort`), keyed off the child's kind. */
  defaultFooter: ReturnType<typeof laneDefaultFooter>;
}

/** One build Leg on the `/pipeline` wire (context-rot rotation read model): a navigable session row under the
 *  thread fold, plus the structured handoff it authored on rotation (the pill shown to the next Leg). */
interface PipelineLeg {
  ordinal: number;
  status: string;
  contextTokensPeak: number | null;
  handoffMd: string | null;
  endedAt: string | null;
}

/**
 * A builder's review children for the `/pipeline` read model. When the child rows are MATERIALIZED (the new
 * child-thread flow — after the builder finished executing), map them directly (real status + findings). When
 * they are NOT (a pre-review builder that hasn't reviewed yet, OR a historical job built before review became
 * child threads), SYNTHESIZE the review set from the thread-kind registry so the rows — and their transcript
 * lanes (the historical review turns still live in `messages` on `autofix:*`) — stay visible. Master-review
 * threads have no review children (they ARE the review). This keeps the review sub-tree data-driven (from the
 * registry, not the dropped `review_agents` jsonb) without the rows vanishing.
 */
function pipelineReviewChildren(
  parent: ThreadEntity,
  materialized: ThreadEntity[],
): PipelineReviewChild[] {
  if (materialized.length > 0) return materialized.map((c) => toPipelineChild(c, parent.id));
  if (parent.kind !== 'builder') return [];
  const spec = threadKindSpec('builder');
  if (!spec.children) return [];
  // A done builder was reviewed (auto-fix ran before it completed) → show the synthesized rows `done`; an
  // in-flight/pending builder shows them queued at `pending` (the review preview). The real per-lens
  // status/findings a historical job once had were in the dropped jsonb, so they degrade to this heuristic —
  // the navigable transcript on each lane is the durable record.
  const status = parent.status === 'done' ? 'done' : 'pending';
  return spec.children({ id: parent.id, config: {} }).map((c) => {
    const lensId = (c.config as { lensId?: string }).lensId;
    return {
      // A deterministic synthetic id (no real row exists) — a bare LEFT-pane node the web can resolve.
      id: `${parent.id}~${c.kind}${lensId ? `~${lensId}` : ''}`,
      kind: c.kind,
      brief: c.brief,
      status,
      condition: 'none',
      ...(lensId ? { lensId } : {}),
      findings: null,
      lane:
        c.kind === 'review_lens'
          ? laneFor('autofix-lens', parent.id, lensId ?? 'review')
          : laneFor('autofix-fix', parent.id),
      defaultFooter: laneDefaultFooter(c.kind),
    };
  });
}

/** Map a thread's `build_legs` rows to the `/pipeline` wire shape — one navigable row per Leg (engine session),
 *  carrying the handoff pill each rotated Leg authored + its peak occupancy. `handoffMd` is the structured
 *  handoff seeded into the NEXT Leg (null for the current/live Leg). Empty in ⇒ empty out (never rotated). */
function pipelineLegs(list: BuildLegEntity[]): PipelineLeg[] {
  return list.map((l) => ({
    ordinal: l.ordinal,
    status: l.status,
    contextTokensPeak: l.context_tokens_peak,
    handoffMd: l.handoff_md,
    endedAt: l.ended_at ? l.ended_at.toISOString() : null,
  }));
}

/**
 * Map a materialized review CHILD row (`review_lens` / `post_review`) to the `/pipeline` wire shape: its id +
 * kind + status + (for a lens) its `lensId`/finding count, plus the streaming lane the web renders it on —
 * `autofix:<parentId>:<lensId>` for a lens, `autofix:<parentId>:fix` for the fix pass (the SAME lanes the
 * turns stream on). The web uses these as bare child-thread nodes (no synthetic `rev:`/`fix:` ids).
 */
function toPipelineChild(c: ThreadEntity, parentId: string): PipelineReviewChild {
  const lensId = (c.config as { lensId?: string })?.lensId;
  return {
    id: c.id,
    kind: c.kind,
    brief: c.brief,
    status: c.status,
    condition: c.condition,
    ...(lensId ? { lensId } : {}),
    findings: Array.isArray(c.review_findings) ? c.review_findings.length : null,
    lane:
      c.kind === 'review_lens'
        ? laneFor('autofix-lens', parentId, lensId ?? 'review')
        : laneFor('autofix-fix', parentId),
    defaultFooter: laneDefaultFooter(c.kind),
  };
}

function toStep(row: StepEntity): Step {
  return {
    id: row.id,
    threadId: row.thread_id,
    jobId: row.job_id,
    ordinal: row.ordinal,
    title: row.title,
    brief: row.brief,
    stage: row.stage,
    status: row.status as StepStatus,
    sessionId: row.session_id,
    batchOrdinal: row.batch_ordinal ?? null,
    legOrdinal: row.leg_ordinal ?? 1,
    commitSha: row.commit_sha ?? null,
  };
}

function toRecord(row: DecisionRecordEntity): DecisionRecord {
  return {
    id: row.id,
    orgId: row.org_id,
    repoId: row.repo_id,
    jobId: row.job_id,
    status: row.status as DecisionRecord['status'],
    overview: row.overview,
    decisions: row.decisions as Decision[],
    threadTitles: row.thread_titles,
    approvedBy: row.approved_by,
    approvedAt: row.approved_at,
  };
}
