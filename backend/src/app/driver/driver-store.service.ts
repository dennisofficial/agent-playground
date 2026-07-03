import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
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
  PlanReviewEntity,
  StepEntity,
  ThreadEntity,
  JobEntity,
} from '../persistence/entities';
import type { ReviewAgentState } from '../persistence/entities';
import { reviewAgentsForThread } from '../autofix/autofix-lenses';
import type { PlannedStep } from './planner-llm';

/** Phases are gap-numbered (10, 20, 30…) so a re-plan can splice without renumbering. */
const ORDINAL_GAP = 10;

/**
 * The thread shape the driver works with — the domain `Thread` plus the denormalized `orgId` the step
 * rows need (steps carry `org_id`). The driver never reaches a repository, so the store carries the one
 * extra field rather than the driver re-querying the thread for it.
 */
export type DriverThread = Thread & { orgId: string };

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
    @InjectRepository(PlanReviewEntity, DB_CONNECTION)
    private readonly reviews: Repository<PlanReviewEntity>,
  ) {}

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
      },
    );
  }

  // ── decision-ledger promotion spine ──────────────────────────────────────────────────────────
  // Two markers (mirrors the plan_reviews spine): a CLAIM (`ledger_promotion_status`) and the
  // proof-of-completion (`ledger_promoted_at`, stamped only after the promotion turn AND the commit).

  /**
   * Atomically CLAIM the ledger promotion: `null | pending | failed` → `running`. Returns true when THIS
   * caller won the claim (so the boot backstop can't race a live driver run). A row already `running` or
   * `complete` is NOT re-claimed here — but the resumable `finishWithPr` re-runs `running` idempotently.
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

  // ── review agents (post-build review fan-out, per-agent status) ────────────────────────────────

  /** Seed the thread's review agents at `pending` from the selected lens set — call before the auto-fix
   *  pass so the navigator can show the agents queued, then transitioned as each lens runs. */
  async seedReviewAgents(
    threadId: string,
    agents: ReviewAgentState[],
  ): Promise<void> {
    await this.threads.update({ id: threadId }, { review_agents: agents });
  }

  /** Transition ONE review agent's status (read-modify-write the jsonb array). A no-op if the thread or the
   *  lens id isn't found (best-effort display state, never sinks the build). */
  async setReviewAgentStatus(
    threadId: string,
    lensId: string,
    status: ReviewAgentState['status'],
    findings?: number,
  ): Promise<void> {
    const thread = await this.threads.findOne({ where: { id: threadId } });
    if (!thread) return;
    const agents = (thread.review_agents ?? []).map((a) =>
      a.id === lensId
        ? { ...a, status, ...(findings != null ? { findings } : {}) }
        : a,
    );
    await this.threads.update({ id: threadId }, { review_agents: agents });
  }

  /** Resolve any review agent still `pending`/`running` once the pass is over — `passed` if its lens ran,
   *  else `skipped` (e.g. the pass threw before reaching it, or the diff was empty). Idempotent. */
  async finalizeReviewAgents(
    threadId: string,
    lensesRun: string[],
  ): Promise<void> {
    const thread = await this.threads.findOne({ where: { id: threadId } });
    if (!thread) return;
    const ran = new Set(lensesRun);
    const agents = (thread.review_agents ?? []).map((a) =>
      a.status === 'pending' || a.status === 'running'
        ? {
            ...a,
            status: ran.has(a.id) ? ('passed' as const) : ('skipped' as const),
          }
        : a,
    );
    await this.threads.update({ id: threadId }, { review_agents: agents });
  }

  // ── PR Review (job-level orchestrator, replaces the old PR-tail lens fan-out) ───────────────────
  // Tasks themselves are NOT mutated here — `TaskEventSink`/`EntityTaskEventSink` in
  // `surface/turn-harness.service.ts` folds `TaskCreate`/`TaskUpdate` events directly, at the shared
  // harness, for every session regardless of caller (avoids this module depending back on `surface`).

  /** Start a fresh PR Review pass: clear any stale task list from an aborted prior attempt and mark
   *  `queued`. Call once, right before kicking the orchestrator session. */
  async startPrReview(jobId: string): Promise<void> {
    await this.jobs.update({ id: jobId }, { tasks: [], pr_review_status: 'queued' });
  }

  /** Transition the PR Review card's coarse status (`running` | `opened` | `failed`). Finer-grained
   *  sub-state ("reviewing"/"fixing"/"verifying") is derived by the reader from whichever task in
   *  `jobs.tasks` is currently `in_progress` — the orchestrator's own task list is already that detailed. */
  async setPrReviewStatus(jobId: string, status: string): Promise<void> {
    await this.jobs.update({ id: jobId }, { pr_review_status: status });
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
    const threads = await this.threads.find({
      where: { job_id: thread.id },
      order: { ordinal: 'ASC' },
    });
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
    // The Codex plan-review dialogue (a lane under Main): summarize its rounds so the navigator can render
    // the "Codex review" row + status/finding badge. Null when the plan was never submitted for review.
    const reviewRows = await this.reviews.find({
      where: { job_id: thread.id },
      order: { round: 'ASC' },
    });
    const latestReview = reviewRows[reviewRows.length - 1];
    const codexReview = latestReview
      ? {
          lane: `codex-review:${thread.id}`,
          rounds: reviewRows.length,
          latestRound: latestReview.round,
          // 'running' | 'complete' | 'failed'
          status: latestReview.status,
          findingsCount: latestReview.findings
            ? latestReview.findings.split('\n').filter((l) => l.trim()).length
            : 0,
        }
      : null;
    return {
      jobId: thread.id,
      title: thread.title,
      kind: thread.kind,
      status: thread.status,
      decisionRecordId: thread.decision_record_id,
      prUrl: thread.pr_url,
      prNumber: thread.pr_number,
      featureBranch: thread.feature_branch,
      baseBranch: thread.base_branch,
      codexReview,
      // The PR-tail review agents over the WHOLE feature diff (the job-level "Final review" node). `[]` until
      // the PR-tail pass seeds them; unlike the per-thread fallback there is no pre-seed default (the pass
      // runs once, after all threads), so an empty array simply means "not reviewed yet".
      reviewAgents: Array.isArray(thread.review_agents) ? thread.review_agents : [],
      // The PR Review orchestrator's LLM-authored task list + card-header status. `[]`/`null` until
      // `BuildShipService.ship()` starts it — no fallback default (tasks are pure LLM output, there's no
      // fixed/expected set the way there is for review agents).
      tasks: Array.isArray(thread.tasks) ? thread.tasks : [],
      prReviewStatus: thread.pr_review_status,
      // The Main brain session's own task list (folded from its `main`-lane task-tool calls) — the
      // navigator's Main row renders it. Same no-fallback rationale as the two lists above.
      mainTasks: Array.isArray(thread.main_tasks) ? thread.main_tasks : [],
      threads: threads.map((s) => ({
        id: s.id,
        ordinal: s.ordinal,
        brief: s.brief,
        type: s.type,
        status: s.status,
        hasPlan: s.plan != null,
        // The review agents that run over this thread's diff, with per-agent status. Once the thread is
        // reviewed `review_agents` carries the live state; before that (the `[]` default for an unseeded /
        // pre-feature thread) fall back to the selected lens set at `pending` so the folder still lists them.
        // Emptiness check (not nullish) — `[]` is the column default.
        reviewAgents:
          Array.isArray(s.review_agents) && s.review_agents.length > 0
            ? s.review_agents
            : reviewAgentsForThread(s).map((a) => ({
                ...a,
                status: 'pending' as const,
              })),
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
