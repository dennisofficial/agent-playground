import { Injectable } from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { randomUUID } from 'node:crypto';
import type {
  Decision,
  DecisionRecord,
  Step,
  StepStatus,
  Thread,
  ThreadStatus,
  Job,
  JobStatus,
} from '../domain';
import { DB_CONNECTION } from '../persistence/database.module';
import {
  DecisionRecordEntity,
  MessageEntity,
  StepEntity,
  ThreadEntity,
  JobEntity,
  CodexReviewEntity,
} from '../persistence/entities';
import type { ThreadTerminalRecord } from '../persistence/entities';
import type { ReviewFinding } from '../autofix';
import { isDriverExecutableKind, threadKindSpec } from '../thread-kind';
import { laneFor } from '../surface/thread-registry';
import type { WebQuestionCard } from '../surface/web-question-card';
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

  /** Every thread currently in `running` — the boot-reconciliation worklist. */
  async runningJobs(): Promise<Job[]> {
    const rows = await this.jobs.find({ where: { status: 'running' } });
    return rows.map(toJob);
  }

  async setJobStatus(jobId: string, status: JobStatus): Promise<void> {
    await this.jobs.update({ id: jobId }, { status });
  }

  /** Record the feature branch all threads stack on (set once, when the sandbox is cut). */
  async setFeatureBranch(jobId: string, branch: string): Promise<void> {
    await this.jobs.update({ id: jobId }, { feature_branch: branch });
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
        // Latch the PR lifecycle to `open` HERE (not on a later reconcile) so the sidebar shows the
        // pull-request glyph the moment the PR is recorded — the reap-timer reconcile is up to 30 min away.
        pr_state: 'open',
      },
    );
  }

  // ── decision-ledger promotion spine ──────────────────────────────────────────────────────────
  // Two markers (mirrors the plan_reviews spine): a CLAIM (`ledger_promotion_status`) and the
  // proof-of-completion (`ledger_promoted_at`, stamped only after the promotion turn AND the commit).

  /**
   * Atomically CLAIM the ledger promotion: `null | pending | failed` → `running`. Returns true when THIS
   * caller won the claim (so the boot backstop can't race a live driver run). A row already `running` or
   * `complete` is NOT re-claimed here — but the resumable `finalizeBuild` re-runs `running` idempotently.
   */
  async claimLedgerPromotion(jobId: string): Promise<boolean> {
    const res = await this.jobs
      .createQueryBuilder()
      .update(JobEntity)
      .set({ ledger_promotion_status: 'running' })
      .where('id = :id', { id: jobId })
      .andWhere(
        "(ledger_promotion_status IS NULL OR ledger_promotion_status IN ('pending', 'failed'))",
      )
      .execute();
    return (res.affected ?? 0) > 0;
  }

  /** Set the promotion lifecycle status (e.g. `failed` on a caught promotion error, retried later). */
  async setLedgerPromotionStatus(
    jobId: string,
    status: string,
  ): Promise<void> {
    await this.jobs.update(
      { id: jobId },
      { ledger_promotion_status: status },
    );
  }

  /** Mark the ledger promotion COMPLETE — stamped ONLY after the promotion turn AND the commit succeed. */
  async markLedgerPromoted(jobId: string): Promise<void> {
    await this.jobs.update(
      { id: jobId },
      { ledger_promotion_status: 'complete', ledger_promoted_at: new Date() },
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
        ? { status: codexRow?.status ?? planReviewThread?.status ?? 'reviewing' }
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
    return {
      jobId: thread.id,
      title: thread.title,
      kind: thread.kind,
      status: thread.status,
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
      featureBranch: thread.feature_branch,
      baseBranch: thread.base_branch,
      // The Main brain session's own task list (folded from its `main`-lane task-tool calls) — the
      // navigator's Main row renders it. No fallback default (tasks are pure LLM output — there's no
      // fixed/expected set the way there is for review agents). The old job-level PR-review fields
      // (`reviewAgents`/`tasks`/`prReviewStatus`) are gone — master review is now a normal build thread.
      mainTasks: Array.isArray(thread.main_tasks) ? thread.main_tasks : [],
      threads: threads.map((s) => ({
        id: s.id,
        ordinal: s.ordinal,
        brief: s.brief,
        type: s.type,
        status: s.status,
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
    decisionRecordId: row.decision_record_id,
    featureBranch: row.feature_branch,
    prUrl: row.pr_url,
    prNumber: row.pr_number,
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
    kind: row.kind,
    parentThreadId: row.parent_thread_id ?? null,
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
    reviewFindings: Array.isArray(row.review_findings) ? row.review_findings : null,
  };
}

/** The `/pipeline` wire shape of a builder's review child (a `review_lens` / `post_review`). */
interface PipelineReviewChild {
  id: string;
  kind: string;
  brief: string;
  status: string;
  lensId?: string;
  findings: number | null;
  lane: string;
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
      ...(lensId ? { lensId } : {}),
      findings: null,
      lane:
        c.kind === 'review_lens'
          ? laneFor('autofix-lens', parent.id, lensId ?? 'review')
          : laneFor('autofix-fix', parent.id),
    };
  });
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
    ...(lensId ? { lensId } : {}),
    findings: Array.isArray(c.review_findings) ? c.review_findings.length : null,
    lane:
      c.kind === 'review_lens'
        ? laneFor('autofix-lens', parentId, lensId ?? 'review')
        : laneFor('autofix-fix', parentId),
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
