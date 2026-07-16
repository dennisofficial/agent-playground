import { Injectable } from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { DataSource, In, IsNull, MoreThan, Raw, Repository } from 'typeorm';
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
} from '@shared/domain';
import { JobDependencyService } from '../job-deps';
import { DB_CONNECTION } from '../persistence/database.module';
import { writeSystemChunk } from '../persistence/system-chunk-writer';
import {
  DecisionRecordEntity,
  TranscriptMessageEntity,
  ThreadGroupEntity,
  TaskEntity,
  ThreadEntity,
  JobEntity,
} from '../persistence/entities';
import type {
  DeviationEntry,
  SessionAnchor,
  TaskItem,
  ThreadTerminalRecord,
} from '../persistence/entities';
import type { ReviewFinding } from '../autofix';
import {
  coerceThreadRole,
  coerceThreadType,
  laneDefaultFooter,
  threadKindSpec,
} from '../thread-kind';
import type { ThreadRole } from '../thread-kind';
import { laneFor } from '../surface/thread-registry';
import type { WebQuestionCard } from '../surface/web-question-card';
import {
  webAmendProposalCard,
  webMergeReadyCard,
  webVerdictCard,
} from '../surface/web-approval-card';
import { prMergeReady } from './auto-merge.service';
import type { PlannedStep } from '../prompt-kit/messages/render-plan';
import type { AgentMessage } from '@shared/prompt-kit/message';

/** Phases are gap-numbered (10, 20, 30…) so a re-plan can splice without renumbering. */
const ORDINAL_GAP = 10;

/**
 * The thread shape the driver works with — the domain `Thread` plus the denormalized `orgId` the step
 * rows need (steps carry `org_id`). The driver never reaches a repository, so the store carries the one
 * extra field rather than the driver re-querying the thread for it.
 */
export type DriverThread = Thread & { orgId: string };

/**
 * The build thread GROUP's persisted skill-nudge selection (`thread_groups.config.skillNudge`) — the skills
 * the Haiku selector picked for the group's build turn, plus when it was decided. Shared by all rotation legs
 * of one logical build.
 */
export type SkillNudge = {
  skills: { name: string; reason: string }[];
  at: string;
};

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
    @InjectRepository(ThreadGroupEntity, DB_CONNECTION)
    private readonly threadGroups: Repository<ThreadGroupEntity>,
    @InjectRepository(TaskEntity, DB_CONNECTION)
    private readonly tasks: Repository<TaskEntity>,
    @InjectRepository(DecisionRecordEntity, DB_CONNECTION)
    private readonly records: Repository<DecisionRecordEntity>,
    @InjectRepository(TranscriptMessageEntity, DB_CONNECTION)
    private readonly messages: Repository<TranscriptMessageEntity>,
    @InjectDataSource(DB_CONNECTION)
    private readonly dataSource: DataSource,
    private readonly jobDeps: JobDependencyService,
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
    const threadId = await this.planningThreadId(jobId);
    await this.dataSource.transaction(async (m) => {
      const messages = m.getRepository(TranscriptMessageEntity);
      await messages.save(
        messages.create({
          job_id: jobId,
          thread_id: threadId,
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
      .setParameter(
        'patch',
        JSON.stringify({ deliveredAt: new Date().toISOString() }),
      )
      .execute();
  }

  // ── thread (the build unit) ────────────────────────────────────────────────────────────────────

  /** Load one thread as the domain shape. */
  async loadJob(jobId: string): Promise<Job> {
    return toJob(await this.jobs.findOneOrFail({ where: { id: jobId } }));
  }

  /** The org OWNER's user id (organization_members.role='owner') — the approver-attribution fallback when
   *  a job's auto_approve_by is null (the enabling user was deleted). Null if the org somehow has no owner. */
  async ownerUserId(orgId: string): Promise<string | null> {
    const rows = await this.dataSource.query<{ user_id: string }[]>(
      `SELECT user_id FROM organization_members WHERE org_id = $1 AND role = 'owner' ORDER BY created_at ASC LIMIT 1`,
      [orgId],
    );
    return rows[0]?.user_id ?? null;
  }

  /** Every thread `running` AND not halted — the boot-reconciliation worklist. The `halt IS NULL` filter is
   *  the primary boot guard: a halted-but-`running` job must not be auto-re-driven (only retry/resume can).
   *  Also leave future `session_resume_at` retry parks alone: the session-resume sweep owns those clocks, and
   *  boot `resume()` must not clear/re-drive a still-cooling host retry early. */
  async runningJobs(): Promise<Job[]> {
    const rows = await this.jobs.find({
      where: {
        status: 'running',
        halt: IsNull(),
        session_resume_at: Raw(
          (alias) => `(${alias} IS NULL OR ${alias} <= now())`,
        ),
      },
    });
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

  /** Recompute the job's build-stage progress and write it change-gated onto the jobs row so the flat
   *  realtime projection carries it live. A build/direct_build thread group is "done" when it has >=1
   *  builder thread and all its builder threads have finished building — status 'done' or 'auto_fixing'
   *  (the review-window affordance). Review is NOT required, and 'auto_fixing' prevents the count
   *  regressing while a just-finished builder is being reviewed. Scoped to the job's ACTIVE plan
   *  revision (`jobs.decision_record_id`), same as {@link threadsForJob} — a mid-build re-plan keeps the
   *  prior revision's build thread groups around as immutable history, and without this filter they'd
   *  keep being counted alongside the new plan's groups forever. */
  async recomputeBuildStageProgress(jobId: string): Promise<void> {
    const job = await this.jobs.findOne({ where: { id: jobId } });
    const activeRecordId = job?.decision_record_id ?? null;
    const groups = await this.threadGroups.find({ where: { job_id: jobId } });
    const buildGroups = groups.filter(
      (g) =>
        (g.kind === 'build' || g.kind === 'direct_build') &&
        (activeRecordId
          ? g.decision_record_id === activeRecordId
          : g.decision_record_id == null),
    );
    const total = buildGroups.length;
    const builderFinished = (s: string) => s === 'done' || s === 'auto_fixing';
    let done = 0;
    for (const g of buildGroups) {
      const builders = await this.threads.find({
        where: { thread_group_id: g.id, role: 'builder' },
        select: { id: true, status: true },
      });
      if (builders.length > 0 && builders.every((t) => builderFinished(t.status)))
        done += 1;
    }
    await this.jobs
      .createQueryBuilder()
      .update()
      .set({ build_stages_done: done, build_stages_total: total })
      .where(
        'id = :id AND (build_stages_done IS DISTINCT FROM :done OR build_stages_total IS DISTINCT FROM :total)',
        { id: jobId, done, total },
      )
      .execute()
      .catch(() => undefined);
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

  /**
   * Has an IDENTICAL system→operator notice already landed on this thread recently? Mirrors the brain-store
   * guard, but build-lane notices are authored through the shared block sink (`author_id='atlas'`) and marked
   * operator-only by `meta.source`, so match on that source rather than author.
   */
  async hasRecentSystemOperatorNotice(
    jobId: string,
    text: string,
    withinMs = 120_000,
  ): Promise<boolean> {
    const since = new Date(Date.now() - withinMs);
    const existing = await this.messages.find({
      where: { job_id: jobId, text, created_at: MoreThan(since) },
      select: { id: true, meta: true },
    });
    return existing.some(
      (m) =>
        (m.meta as { source?: unknown } | null)?.source === 'system_operator',
    );
  }

  /**
   * Set (or clear) the durable auto-resume clock a lane parks on when it hits a Claude session/usage limit.
   * `resumeAt=null` (with `meta=null`) clears the clock so the leader sweep never re-fires — called on every
   * un-park path (retry / resumePaused / the sweep itself). See {@link JobEntity.session_resume_at}.
   */
  async setSessionResume(
    jobId: string,
    resumeAt: string | null,
    meta: JobEntity['session_resume'],
  ): Promise<void> {
    await this.jobs.update(
      { id: jobId },
      {
        session_resume_at: resumeAt ? new Date(resumeAt) : null,
        session_resume: meta,
      },
    );
  }

  /** Clear only a host-backstop retry park for this lane; leave session-limit parks untouched. */
  async clearRetrySessionResume(
    jobId: string,
    lane: 'main' | 'build',
  ): Promise<void> {
    await this.jobs
      .createQueryBuilder()
      .update(JobEntity)
      .set({ session_resume_at: null, session_resume: null })
      .where('id = :jobId', { jobId })
      .andWhere("session_resume->>'kind' = 'retry'")
      .andWhere("session_resume->>'lane' = :lane", { lane })
      .execute();
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
   * PARK the job at the ship-review gate in one txn: flip `running | amending → awaiting_ship_review`, clear
   * activity to `idle`, and post the durable "Ship it" card. The status flip is CONDITIONAL, so it's the
   * single-park guard — a concurrent drive (or a re-drive) that finds the job already parked affects 0 rows
   * and skips the card, returning false. Returns whether THIS caller parked it.
   *
   * `running` is the normal path (a build drive that finished + passed master review). `amending` is the
   * AMEND re-park: after an approved `withdraw_ship`, the brain does the follow-up work and re-arms the gate
   * directly from `amending` (no detour back through a `running` build) — see AgentSessionManager's
   * `report_verification`.
   */
  async parkForShipReview(
    jobId: string,
    card: Record<string, unknown>,
    summary: string,
    orgId: string,
    decisionRecordId: string | null,
  ): Promise<boolean> {
    const parked = await this.dataSource.transaction(async (m) => {
      const res = await m
        .getRepository(JobEntity)
        .createQueryBuilder()
        .update(JobEntity)
        .set({ status: 'awaiting_ship_review', activity: 'idle' })
        .where('id = :jobId', { jobId })
        .andWhere("status IN ('running', 'amending')")
        .execute();
      if ((res.affected ?? 0) === 0) return false;
      const messages = m.getRepository(TranscriptMessageEntity);
      await messages.save(
        messages.create({
          job_id: jobId,
          thread_id: await this.planningThreadId(jobId),
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
    // Spawn the post_build session at the GATE (idempotent) so preview/amend taps have a session to land
    // on before the operator can act — only when THIS call actually transitioned the job.
    if (parked) {
      await this.ensurePostBuildThread({ jobId, orgId, decisionRecordId });
    }
    return parked;
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
      const messages = m.getRepository(TranscriptMessageEntity);
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

  /**
   * Stamp the ship card "preview requested" when the operator clicks "Spin up preview" at the ship gate —
   * ATOMICALLY and IDEMPOTENTLY, mirroring {@link BrainStoreService.markQuestionAnswered}. The conditional
   * `WHERE … previewRequestedAt IS NULL` makes a concurrent double-click single-winner; the `jobs.status`
   * subquery keeps the status gate atomic with the stamp instead of trusting a stale controller snapshot.
   * The `type='approval_card'` + `kind='ship'` guards scope the stamp to an ACTIVE ship card — a retracted
   * card has been neutralized to a `verdict_card` (see {@link retractShip}), so it can't be stamped. Returns
   * whether THIS caller stamped it (the winner then seeds the preview procedure).
   */
  async markPreviewRequested(jobId: string): Promise<boolean> {
    const patch = JSON.stringify({
      previewRequestedAt: new Date().toISOString(),
    });
    const res = await this.messages
      .createQueryBuilder()
      .update(TranscriptMessageEntity)
      .set({ card: () => 'card || :patch::jsonb' })
      .where('job_id = :jobId', { jobId })
      .andWhere('ts = :ts', { ts: `ship-review:${jobId}` })
      .andWhere("kind = 'card'")
      .andWhere("card ->> 'type' = 'approval_card'")
      .andWhere("card ->> 'kind' = 'ship'")
      .andWhere("card ->> 'previewRequestedAt' IS NULL")
      .andWhere(
        "EXISTS (SELECT 1 FROM jobs j WHERE j.id = :jobId AND j.status = 'awaiting_ship_review')",
      )
      .setParameter('patch', patch)
      .execute();
    return (res.affected ?? 0) > 0;
  }

  /**
   * OPEN the brain's "Amend build?" proposal — posted by the `withdraw_ship` tool. Unlike `retractShip`,
   * this does NOT flip the job status: the gate STAYS parked at `awaiting_ship_review` until the operator
   * approves. It just posts a durable `kind:'amend'` proposal card carrying the brain's `reason`. Returns:
   *  - `'not-parked'`  — the job isn't at the ship-review gate (nothing to propose)
   *  - `'already-open'` — an actionable amend proposal card already exists (don't double-post)
   *  - `'posted'`       — a fresh proposal card was written
   * Keyed on a deterministic `ts` (`amend-proposal:${jobId}`) so `neutralizeAmendProposal` can find it.
   */
  async openAmendProposal(
    jobId: string,
    reason: string,
  ): Promise<'posted' | 'not-parked' | 'already-open'> {
    return this.dataSource.transaction(async (m) => {
      const job = await m
        .getRepository(JobEntity)
        .findOne({ where: { id: jobId } });
      if (!job || job.status !== 'awaiting_ship_review') return 'not-parked';
      const messages = m.getRepository(TranscriptMessageEntity);
      const existing = await messages.find({
        where: { job_id: jobId, ts: `amend-proposal:${jobId}`, kind: 'card' },
      });
      // An amend proposal is still actionable while its card is an `approval_card` (a resolved one has been
      // rewritten to a `verdict_card`). If one is live, don't stack a second.
      if (
        existing.some(
          (row) =>
            (row.card as Record<string, unknown> | null)?.['type'] ===
            'approval_card',
        )
      ) {
        return 'already-open';
      }
      await messages.save(
        messages.create({
          job_id: jobId,
          thread_id: await this.planningThreadId(jobId),
          author: 'Atlas',
          author_id: 'atlas',
          author_bot_id: 'atlas',
          text: reason || 'Amend build?',
          kind: 'card',
          ts: `amend-proposal:${jobId}`,
          card: webAmendProposalCard({ jobId, reason }) as unknown as Record<
            string,
            unknown
          >,
        }),
      );
      return 'posted';
    });
  }

  /**
   * NEUTRALIZE the brain's amend proposal card — called on BOTH Approve and Dismiss so its buttons stop
   * being actionable. Rewrites every still-actionable `amend-proposal:${jobId}` card to a `verdict_card`
   * carrying `verdictLine`. Idempotent: already-neutralized rows (`verdict_card`) are skipped. Does NOT
   * touch job status (the Approve path's retract handles that; Dismiss leaves the gate parked).
   */
  async neutralizeAmendProposal(
    jobId: string,
    verdictLine: string,
  ): Promise<void> {
    const rows = await this.messages.find({
      where: { job_id: jobId, ts: `amend-proposal:${jobId}`, kind: 'card' },
    });
    for (const row of rows) {
      const card = row.card as Record<string, unknown> | null;
      if (card?.['type'] !== 'approval_card') continue;
      const title = String(card?.['title'] ?? 'Amend build?');
      const verdict = verdictLine.toLowerCase().includes('dismiss')
        ? 'dismissed'
        : 'approved';
      row.card = webVerdictCard(
        jobId,
        title,
        verdict,
        verdictLine,
      ) as unknown as Record<string, unknown>;
      await this.messages.save(row);
    }
  }

  // ── merge-ready gate (the third human gate: GitHub-mergeable → post the "Merge PR" card) ──────────────

  /** Post (or refresh) the durable "Merge PR" card — keyed on a FIXED `ts` so repeated calls (the
   *  reconciler re-evaluates on every poll) UPDATE the same row instead of stacking duplicates. Does NOT
   *  touch job status: the job stays wherever it is, this is purely an informational/actionable card. */
  async postMergeCard(jobId: string): Promise<void> {
    const ts = `merge-ready:${jobId}`;
    const card = webMergeReadyCard(jobId) as unknown as Record<string, unknown>;
    const existing = await this.messages.findOne({
      where: { job_id: jobId, ts, kind: 'card' },
    });
    if (existing) {
      existing.card = card;
      await this.messages.save(existing);
      return;
    }
    await this.messages.save(
      this.messages.create({
        job_id: jobId,
        thread_id: await this.planningThreadId(jobId),
        author: 'Atlas',
        author_id: 'atlas',
        author_bot_id: 'atlas',
        text: 'This PR is ready to merge.',
        kind: 'card',
        ts,
        card,
      }),
    );
  }

  /** Neutralize the "Merge PR" card once it's no longer actionable — rewrites it to a verdict card so a
   *  stale button can't be clicked. `outcome` distinguishes an actual merge (`'merged'` → '✅ Merged.')
   *  from the PR merely leaving the merge-ready state (`'not-ready'` → 'No longer ready to merge.'): the
   *  latter fires whenever the PR turns dirty / CI regresses / it closes unmerged, so it must NOT claim
   *  success. Best-effort: a missing or already-neutralized row is a silent no-op. */
  async neutralizeMergeCard(
    jobId: string,
    outcome: 'merged' | 'not-ready' = 'merged',
  ): Promise<void> {
    const ts = `merge-ready:${jobId}`;
    const row = await this.messages.findOne({
      where: { job_id: jobId, ts, kind: 'card' },
    });
    if (!row) return;
    const card = row.card as Record<string, unknown> | null;
    if (card?.['type'] !== 'approval_card') return;
    const title = String(card?.['title'] ?? 'Merge PR');
    const [verdict, verdictLine] =
      outcome === 'merged'
        ? (['merged', '✅ Merged.'] as const)
        : (['expired', 'No longer ready to merge.'] as const);
    row.card = webVerdictCard(
      jobId,
      title,
      verdict,
      verdictLine,
    ) as unknown as Record<string, unknown>;
    await this.messages.save(row);
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

  /**
   * The job's threads for the ACTIVE plan revision, in execution order (ORDER BY ordinal). Scoped to
   * `jobs.decision_record_id` so a superseded revision's threads (browsable history) are NEVER re-driven —
   * without this, an old `master_review` or a prior revision's pending builder would re-run. NULL-record
   * job-level singletons (`main`/`plan_review`) are excluded here (the two callers — `runJob` and the
   * final-delivery gaps loop — want only executable active-revision rows; `main` is filtered out by
   * `isDriverExecutableKind` anyway). A job with no active revision yet (early planning) matches the
   * NULL-record rows, of which none are executable.
   */
  async threadsForJob(jobId: string): Promise<DriverThread[]> {
    const job = await this.jobs.findOne({ where: { id: jobId } });
    const activeRecordId = job?.decision_record_id ?? null;
    // Plan-revision scoping moved off the thread onto its thread group (d7). Join through `thread_groups` and match the
    // job's active revision so a superseded revision's threads (browsable history) are never re-driven.
    const qb = this.threads
      .createQueryBuilder('t')
      .innerJoin(ThreadGroupEntity, 's', 's.id = t.thread_group_id')
      .where('t.job_id = :jobId', { jobId })
      .orderBy('t.ordinal', 'ASC');
    if (activeRecordId)
      qb.andWhere('s.decision_record_id = :activeRecordId', { activeRecordId });
    else qb.andWhere('s.decision_record_id IS NULL');
    const rows = await qb.getMany();
    return rows.map(toThread);
  }

  async setThreadStatus(threadId: string, status: ThreadStatus): Promise<void> {
    await this.threads.update({ id: threadId }, { status });
  }

  async setThreadCondition(
    threadId: string,
    condition: ThreadCondition,
  ): Promise<void> {
    await this.threads.update({ id: threadId }, { condition });
  }

  /**
   * SET-ONCE the thread's start HEAD and return the AUTHORITATIVE value. The conditional update (`start_sha
   * IS NULL`) makes the first writer win, so a concurrent/resumed drive never overwrites the base; the
   * read-back then returns whatever actually landed so every drive converges on the same `start_sha..HEAD`
   * review range. Idempotent — a second call with the row already set is a no-op returning the stored sha.
   */
  async ensureThreadStartSha(
    threadId: string,
    candidate: string,
  ): Promise<string> {
    await this.threads.update(
      { id: threadId, start_sha: IsNull() },
      { start_sha: candidate },
    );
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
  // ── Leg rotation (context-rot mitigation: one build thread group → many sequential builder-thread legs) ─────
  // A "Leg" is now a builder-thread row under a build thread group (d1): rotation inserts the next builder row
  // rather than mutating one step. The `anchorStepId` the driver passes is the CURRENT builder thread's id
  // (steps are gone; the thread is the atomic unit). Leg-scoped params (the pending seed, the peak
  // occupancy) live in `threads.config` — no per-leg satellite table.

  /**
   * Record the CURRENT builder thread's live session id (display-only; the caller swallows errors). Also
   * folds the peak context occupancy into `config.contextTokensPeak` (max-of, for parity with the old
   * `build_legs.context_tokens_peak`). No-op-safe if the thread is gone; a null session is left untouched
   * so a display refresh never clobbers a live session.
   */
  async recordActiveLeg(
    anchorStepId: string,
    sessionId: string | null,
    contextTokensPeak?: number | null,
  ): Promise<void> {
    const thread = await this.threads.findOne({
      where: { id: anchorStepId },
      select: { id: true, config: true },
    });
    if (!thread) return;
    const config = isRecord(thread.config) ? thread.config : {};
    const priorPeak =
      typeof config.contextTokensPeak === 'number'
        ? config.contextTokensPeak
        : null;
    const nextPeak =
      contextTokensPeak != null
        ? Math.max(priorPeak ?? 0, contextTokensPeak)
        : null;
    const patch = {
      ...(sessionId != null ? { session_id: sessionId } : {}),
      ...(nextPeak != null
        ? { config: { ...config, contextTokensPeak: nextPeak } }
        : {}),
    };
    if (Object.keys(patch).length === 0) return;
    await this.threads.update({ id: anchorStepId }, patch);
  }

  /**
   * Read the build thread GROUP's persisted skill-nudge selection. The grain is the group, not the thread
   * row: a rotation leg is a fresh `threads` row that does NOT inherit config, so per-thread persistence would
   * re-run the Haiku selector every leg. A PRESENT key (even `{skills:[]}`) means "already decided" — the
   * caller reuses it and skips selection. Returns null when the group has no selection yet.
   */
  async readGroupSkillNudge(threadGroupId: string): Promise<SkillNudge | null> {
    const g = await this.threadGroups.findOne({
      where: { id: threadGroupId },
      select: { id: true, config: true },
    });
    const v = isRecord(g?.config) ? g!.config.skillNudge : undefined;
    return isSkillNudge(v) ? v : null;
  }

  /**
   * Persist the skill-nudge selection on the build thread GROUP's config (read-merge-write, mirroring
   * `foldContextPeak`). Written once per group on the first build leg — including an empty `{skills:[]}` so a
   * group with no relevant skill is not re-selected on every subsequent leg.
   */
  async persistGroupSkillNudge(
    threadGroupId: string,
    nudge: SkillNudge,
  ): Promise<void> {
    const g = await this.threadGroups.findOne({
      where: { id: threadGroupId },
      select: { id: true, config: true },
    });
    const config = isRecord(g?.config) ? g!.config : {};
    await this.threadGroups.update(
      { id: threadGroupId },
      { config: { ...config, skillNudge: nudge } },
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
    text: AgentMessage;
    chunkKey: string;
    reminderKind?: string;
  }): Promise<void> {
    return writeSystemChunk(
      this.messages,
      {
        jobId: input.jobId,
        // `phaseId` was repointed to `thread_id` when the `steps` table was retired, so it IS the build
        // thread's `threads.id` — the same row this chunk belongs to.
        threadId: input.phaseId,
        kind: input.kind,
        text: input.text,
        chunkKey: input.chunkKey,
        reminderKind: input.reminderKind,
      },
      { phaseId: input.phaseId, legOrdinal: input.legOrdinal },
    );
  }

  /**
   * ROTATE a builder thread's build session (d1): insert the NEXT builder-thread row under the SAME thread group,
   * carrying the handoff forward as `handoff_in` and the continuation seed as `config.pendingLegSeed`, on a
   * fresh (null) session. `rotationCapped` marks the final safety-valve leg: it receives the seed and remains
   * operator-steerable, but the driver does not expose another `record_leg_handoff` tool. The `anchorStepId` is
   * the CURRENT builder thread's id. `fromLeg` is that thread's 1-based position among the thread group's builder
   * threads (ORDER BY ordinal); the new row is `toLeg = fromLeg+1` at the next gap-numbered ordinal. Returns
   * null (no-op) when there is no live session to rotate.
   */
  async completeLegRotation(input: {
    anchorStepId: string;
    handoff: string;
    seed: string;
    rotationCapped?: boolean;
    contextTokensPeak?: number | null;
  }): Promise<{
    fromLeg: number;
    toLeg: number;
    abandonedSessionId: string;
  } | null> {
    return this.dataSource.transaction(async (m) => {
      const threads = m.getRepository(ThreadEntity);
      const current = await threads.findOne({
        where: { id: input.anchorStepId },
      });
      if (!current || !current.session_id) return null; // nothing live to rotate
      const abandonedSessionId = current.session_id;
      const siblings = await threads.find({
        where: { thread_group_id: current.thread_group_id, role: 'builder' },
        order: { ordinal: 'ASC' },
      });
      const position = siblings.findIndex((s) => s.id === current.id);
      const fromLeg = position >= 0 ? position + 1 : siblings.length;
      const toLeg = fromLeg + 1;
      // Allocate the new leg's ordinal from the JOB-GLOBAL max for this parent scope — NOT the stage's
      // sibling max. `uq_threads_job_parent_ordinal` is UNIQUE(job_id, parent_thread_id, ordinal) NULLS NOT
      // DISTINCT (job-global, not per-stage), so on a multi-stage build a stage-local `max+GAP` (e.g. 30→40)
      // collides with a SIBLING STAGE's thread already at that ordinal — the INSERT then throws a unique
      // violation, this txn rolls back to null, and rotation silently fails (the whole "handoff rotation
      // isn't working" bug). Scoping the max to (job_id, parent_thread_id) guarantees a free ordinal; the
      // leg still sorts after its predecessor within the stage (its ordinal is strictly greater).
      const parentThreadId = current.parent_thread_id;
      const maxOrdinalRow = await threads
        .createQueryBuilder('t')
        .select('MAX(t.ordinal)', 'max')
        .where('t.job_id = :jobId', { jobId: current.job_id })
        .andWhere(
          parentThreadId == null
            ? 't.parent_thread_id IS NULL'
            : 't.parent_thread_id = :parentThreadId',
          parentThreadId == null ? {} : { parentThreadId },
        )
        .getRawOne<{ max: number | null }>();
      const nextOrdinal = (maxOrdinalRow?.max ?? 0) + ORDINAL_GAP;
      await threads.save(
        threads.create({
          job_id: current.job_id,
          thread_group_id: current.thread_group_id,
          org_id: current.org_id,
          parent_thread_id: current.parent_thread_id,
          role: 'builder',
          ordinal: nextOrdinal,
          brief: current.brief,
          type: current.type,
          handoff_in: input.handoff,
          session_id: null,
          status: 'pending',
          config: {
            pendingLegSeed: input.seed,
            ...(input.rotationCapped ? { rotationCapped: true } : {}),
          },
        }),
      );
      return { fromLeg, toLeg, abandonedSessionId };
    });
  }

  /** Read a builder thread's pending Leg seed (the handoff folded into the next turn's task) from its
   *  `config.pendingLegSeed`, or null. */
  async getPendingLegSeed(anchorStepId: string): Promise<string | null> {
    const thread = await this.threads.findOne({
      where: { id: anchorStepId },
      select: { id: true, config: true },
    });
    const seed = isRecord(thread?.config)
      ? thread!.config.pendingLegSeed
      : null;
    return typeof seed === 'string' ? seed : null;
  }

  /** A thread's thread-group-owned task checklist (`tasks WHERE thread_group_id = X`, d6), mapped to the `TaskItem` shape
   *  — read when rotating so the fresh Leg's seed carries the open/in-progress items. */
  async getThreadTasks(threadId: string): Promise<TaskItem[]> {
    const thread = await this.threads.findOne({
      where: { id: threadId },
      select: { id: true, thread_group_id: true },
    });
    if (!thread) return [];
    const rows = await this.tasksForThreadGroup(thread.thread_group_id);
    return rows.map(toTaskItem);
  }

  /** Host backstop for a thread that reached `done` with an unreconciled checklist: flip every still-open task
   *  (`pending`/`in_progress`) in its thread group to `dropped` — NOT `completed` (the host must not claim work it did
   *  not verify; a `dropped` row renders struck-through / drops out of the live navigator checklist).
   *  Returns how many were flipped. */
  async dropOpenThreadTasks(threadId: string): Promise<number> {
    const thread = await this.threads.findOne({
      where: { id: threadId },
      select: { id: true, thread_group_id: true },
    });
    if (!thread) return 0;
    const res = await this.tasks
      .createQueryBuilder()
      .update(TaskEntity)
      .set({ status: 'dropped' })
      .where('thread_group_id = :threadGroupId', { threadGroupId: thread.thread_group_id })
      .andWhere("status IN ('pending', 'in_progress')")
      .execute();
    return res.affected ?? 0;
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
    await this.threads.update(
      { id: threadId },
      { plan, handoff_in: handoffIn },
    );
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
  async setThreadHandoffOut(
    threadId: string,
    handoffOut: string,
  ): Promise<void> {
    await this.threads.update({ id: threadId }, { handoff_out: handoffOut });
  }

  /** Append an inline out-of-scope fix to `threads.deviations` (from the builder's `record_deviation` tool).
   *  Idempotent on note text so a re-driven turn re-recording the same fix doesn't duplicate it — the durable
   *  source behind the `/context/generated/deviations.md` projection. Single host writer per thread, so a plain
   *  read-modify-write is race-free. */
  async recordDeviation(
    threadId: string,
    entry: DeviationEntry,
  ): Promise<void> {
    const row = await this.threads.findOne({
      where: { id: threadId },
      select: { id: true, deviations: true },
    });
    if (!row) return;
    const current = Array.isArray(row.deviations) ? row.deviations : [];
    if (current.some((d) => d.note.trim() === entry.note.trim())) return;
    await this.threads.update(
      { id: threadId },
      { deviations: [...current, entry] },
    );
  }

  /** Every thread of a job that recorded at least one inline deviation, ordered for the `deviations.md`
   *  projection (which re-renders the whole file from this — never appends). */
  async getJobDeviations(
    jobId: string,
  ): Promise<
    { ordinal: number; brief: string; deviations: DeviationEntry[] }[]
  > {
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

  /** Persist the orchestrator's typed done-report (from `complete_thread`). */
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
  async getTerminalRecord(
    threadId: string,
  ): Promise<ThreadTerminalRecord | null> {
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

  /** The job's `master_review` thread id — the carrier for the `'final'` completion wake — or null if the
   *  job has none (yet). */
  async masterReviewThreadId(jobId: string): Promise<string | null> {
    const row = await this.threads.findOne({
      where: { job_id: jobId, role: 'master_review' },
      select: { id: true },
    });
    return row?.id ?? null;
  }

  /** CAS-claim one auth transient-error auto-retry attempt (driver lane). Atomically increment
   *  `auth_retry_attempts` iff still below `cap`, stamping `retry_last_attempt_at`. Returns `{ok:true, used}`
   *  on success, else `{ok:false, used:cap}` (budget exhausted). Durable so a restart/crash-loop can't
   *  re-grant a fresh budget. */
  async claimAuthRetryAttempt(
    jobId: string,
    cap: number,
  ): Promise<{ ok: boolean; used: number }> {
    const res = await this.jobs
      .createQueryBuilder()
      .update(JobEntity)
      .set({
        auth_retry_attempts: () => 'auth_retry_attempts + 1',
        retry_last_attempt_at: () => 'now()',
      })
      .where('id = :jobId', { jobId })
      .andWhere('auth_retry_attempts < :cap', { cap })
      .returning('auth_retry_attempts')
      .execute();
    const used = res.raw?.[0]?.auth_retry_attempts as number | undefined;
    return used != null ? { ok: true, used } : { ok: false, used: cap };
  }

  /** CAS-claim one host-transport transient-error auto-retry attempt (driver lane). Same shape as
   *  {@link claimAuthRetryAttempt} against `driver_transient_retries`. */
  async claimDriverTransientRetry(
    jobId: string,
    cap: number,
  ): Promise<{ ok: boolean; used: number }> {
    const res = await this.jobs
      .createQueryBuilder()
      .update(JobEntity)
      .set({
        driver_transient_retries: () => 'driver_transient_retries + 1',
        retry_last_attempt_at: () => 'now()',
      })
      .where('id = :jobId', { jobId })
      .andWhere('driver_transient_retries < :cap', { cap })
      .returning('driver_transient_retries')
      .execute();
    const used = res.raw?.[0]?.driver_transient_retries as number | undefined;
    return used != null ? { ok: true, used } : { ok: false, used: cap };
  }

  /** CAS-claim one consecutive UNCORROBORATED text-fallback session-limit misfire for the job; refuses at
   *  `cap`. */
  async claimSessionLimitTextMisfire(jobId: string, cap: number): Promise<{ ok: boolean; used: number }> {
    const res = await this.jobs
      .createQueryBuilder()
      .update(JobEntity)
      .set({ session_limit_text_misfires: () => 'session_limit_text_misfires + 1' })
      .where('id = :jobId', { jobId })
      .andWhere('session_limit_text_misfires < :cap', { cap })
      .returning('session_limit_text_misfires')
      .execute();
    const used = res.raw?.[0]?.session_limit_text_misfires as number | undefined;
    return used != null ? { ok: true, used } : { ok: false, used: cap };
  }

  /** Reset the driver's SESSION-scoped retry budgets to 0 on a clean drive. Does NOT touch
   *  `retry_last_attempt_at` nor the brain's own lane columns. */
  async clearDriverRetryCounters(jobId: string): Promise<void> {
    await this.jobs.update(
      { id: jobId },
      {
        auth_retry_attempts: 0,
        driver_transient_retries: 0,
        session_limit_text_misfires: 0,
      },
    );
  }

  /** Read back the durable driver-transient-retry state (count + last-attempt timestamp) so a boot
   *  re-entry into `runJobWithTransientRetry` can honor an in-flight cooldown instead of re-driving
   *  immediately after a restart. */
  async driverTransientRetryState(
    jobId: string,
  ): Promise<{ count: number; lastAttemptAt: Date | null }> {
    const row = await this.jobs.findOne({
      where: { id: jobId },
      select: {
        id: true,
        driver_transient_retries: true,
        retry_last_attempt_at: true,
      },
    });
    return {
      count: row?.driver_transient_retries ?? 0,
      lastAttemptAt: row?.retry_last_attempt_at ?? null,
    };
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
    childSpecs: Array<{
      kind: string;
      brief: string;
      config: Record<string, unknown>;
    }>,
  ): Promise<ReviewChildThread[]> {
    const existing = await this.reviewChildren(parent.id);
    if (existing.length > 0) return existing;
    // A review child belongs to the SAME thread group as its parent builder (`threads.thread_group_id` NOT NULL). Derive
    // it from the parent row rather than requiring the caller to pass it — the caller (thread-driver) supplies
    // only `{id, jobId, orgId}`.
    const parentRow = await this.threads.findOne({
      where: { id: parent.id },
      select: { id: true, thread_group_id: true },
    });
    if (!parentRow) return [];
    const rows = childSpecs.map((c, i) =>
      this.threads.create({
        job_id: parent.jobId,
        org_id: parent.orgId,
        thread_group_id: parentRow.thread_group_id,
        parent_thread_id: parent.id,
        role: c.kind,
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

  // ── steps (now 1:1 with the thread row — steps table is gone) ─────────────────────────────────
  // `lockSteps` always created exactly one planned step per thread, so a thread's "steps" collapse to a
  // single synthetic Step derived from the thread row itself. The `stepId` the driver passes back is always
  // the thread's own id, so the step writers below target the thread row directly.

  /** A thread's steps in execution order — a single synthetic step derived 1:1 from the thread row. */
  async stepsForThread(threadId: string): Promise<Step[]> {
    const thread = await this.threads.findOne({ where: { id: threadId } });
    if (!thread) return [];
    return [await this.toSyntheticStep(thread)];
  }

  /**
   * The AUTHORITATIVE transcript anchor for a thread — the engine `sessionId` (+ Leg ordinal) the wake hands
   * the brain to read the halted/completed lane's raw JSONL (`atlas-tx show <sessionId>`). Reads the thread's
   * own `session_id` directly (relocated off the old `steps`/`build_legs`), so it works even for an
   * `incomplete` halt whose `terminal_record` is null. `undefined` when the thread never got a session.
   */
  async resolveSessionAnchor(
    threadId: string,
  ): Promise<SessionAnchor | undefined> {
    const thread = await this.threads.findOne({
      where: { id: threadId },
      select: { id: true, thread_group_id: true, session_id: true },
    });
    if (!thread?.session_id) return undefined;
    return {
      sessionId: thread.session_id,
      legOrdinal: await this.builderLegOrdinal(thread),
    };
  }

  /**
   * Lock a thread's steps — a no-op now that a thread's single step IS the thread row (the row was created
   * upstream when the thread was materialized). Returns the synthetic step, so callers keep the same shape.
   */
  async lockSteps(
    thread: DriverThread,
    _planned: PlannedStep[],
  ): Promise<Step[]> {
    return this.stepsForThread(thread.id);
  }

  /** Advance the (synthetic) step's cursor — maps the `StepStatus` back to the owning thread's `status`. The
   *  `stage` intra-step cursor has no durable home anymore and is ignored. */
  async setStepState(
    stepId: string,
    _stage: string,
    status: StepStatus,
  ): Promise<void> {
    await this.threads.update(
      { id: stepId },
      { status: stepStatusToThreadStatus(status) },
    );
  }

  /** Stamp the thread's commit marker (the review-diff head) the instant its batch commits. */
  async setStepCommit(stepId: string, commitSha: string): Promise<void> {
    await this.threads.update({ id: stepId }, { commit_sha: commitSha });
  }

  /** No-op: a thread has a single batch (batchOrdinal is always 1 today), so there is nothing durable to
   *  persist for batch grouping. Kept for signature compatibility with the driver's batching seam. */
  async setBatchOrdinals(_assignments: Array<[string, number]>): Promise<void> {
    // Intentionally empty — see the method doc.
  }

  /** The 1-based position of a builder thread among its thread group's builder threads (ORDER BY ordinal) — the
   *  "Leg N" ordinal. Non-builder threads (or a thread with no siblings) resolve to 1. */
  private async builderLegOrdinal(thread: {
    id: string;
    thread_group_id: string;
  }): Promise<number> {
    const siblings = await this.threads.find({
      where: { thread_group_id: thread.thread_group_id, role: 'builder' },
      order: { ordinal: 'ASC' },
      select: { id: true },
    });
    const idx = siblings.findIndex((s) => s.id === thread.id);
    return idx >= 0 ? idx + 1 : 1;
  }

  /** Project a thread row to the single synthetic {@link Step} the driver + build-lane delivery read. */
  private async toSyntheticStep(thread: ThreadEntity): Promise<Step> {
    return {
      id: thread.id,
      threadId: thread.id,
      jobId: thread.job_id,
      ordinal: thread.ordinal,
      title: null,
      brief: thread.brief,
      stage: 'build',
      status: threadStatusToStepStatus(thread.status),
      sessionId: thread.session_id,
      batchOrdinal: 1,
      legOrdinal: await this.builderLegOrdinal(thread),
      commitSha: thread.commit_sha,
    };
  }

  // ── brain read helpers ───────────────────────────────────────────────────────────────────────

  /**
   * R3 — `get_pipeline_state` tool impl. Returns the current build + thread state for a thread, or
   * `{ status: 'no_job' }` if the thread hasn't entered the build lifecycle. Used by the in-sandbox
   * AgentSessionManager brain session.
   */
  async getPipelineState(jobId: string, orgId: string): Promise<unknown> {
    const job = await this.jobs.findOne({
      where: { id: jobId, org_id: orgId },
    });
    if (!job) return { status: 'no_job' };
    const blockedBy =
      job.status === 'blocked' ? await this.jobDeps.blockersOf(jobId) : [];
    // The pending seed message a born-blocked job will start on when it unblocks (jobs.blocked_seed_message,
    // cleared on wake). Surfaced only while blocked so the web can preview it in the blocked overlay.
    const blockedSeedMessage =
      job.status === 'blocked' ? (job.blocked_seed_message ?? null) : null;
    // An `open` job (chatting/planning, never entered the build lifecycle) has no pipeline — but its brain can
    // already be keeping a task list on its (always-present) planning thread group, and the navigator's Main row shows
    // it. Ride the no_job payload so the web isn't blind to it before a plan exists.
    if (job.status === 'open') {
      const planningThreadGroup = await this.threadGroups.findOne({
        where: { job_id: job.id, kind: 'planning' },
        order: { ordinal: 'ASC' },
      });
      const mainTasks = planningThreadGroup
        ? (await this.tasksForThreadGroup(planningThreadGroup.id)).map(toTaskItem)
        : [];
      return {
        status: 'no_job',
        mainTasks,
        // The planning lane's pre-turn footer default — so a planning job shows "Opus 4.8" before its first
        // brain turn completes (no `turn_meta` to derive from yet).
        mainDefaultFooter: laneDefaultFooter('planning'),
        createdBy: job.created_by ?? null,
        autoApproveMode: job.auto_approve_mode ?? 'off',
        autoMerge: job.auto_merge ?? false,
        mergeReady: prMergeReady(job),
        mergeValue: prMergeReady(job)
          ? JSON.stringify({ jobId: job.id })
          : null,
        blockedBy,
        blockedSeedMessage,
      };
    }
    // The pipeline is now the job's ordinal-ordered THREAD GROUPS; each thread group owns its threads (root +
    // review children) and its task checklist. Batch the threads + tasks in one query each and group by thread group.
    const threadGroups = await this.threadGroupsForJob(job.id);
    const allThreads = await this.threads.find({
      where: { job_id: job.id },
      order: { ordinal: 'ASC' },
    });
    const threadsByThreadGroup = groupBy(allThreads, (t) => t.thread_group_id);
    const threadGroupIds = threadGroups.map((s) => s.id);
    const allTasks = threadGroupIds.length
      ? await this.tasks.find({
          where: { thread_group_id: In(threadGroupIds) },
          order: { ordinal: 'ASC' },
        })
      : [];
    const tasksByThreadGroup = groupBy(allTasks, (t) => t.thread_group_id);

    const mapThread = (t: ThreadEntity, siblings: ThreadEntity[]) => ({
      id: t.id,
      role: t.role,
      ordinal: t.ordinal,
      brief: t.brief,
      type: coerceThreadType(t.type),
      status: t.status,
      condition: t.condition,
      hasPlan: t.plan != null,
      sessionId: t.session_id,
      commitSha: t.commit_sha,
      // The verification-gate reason taxonomy + judge-outage "Skip & accept" hold are gone: a thread that
      // isn't done now lands in the single `incomplete` condition (surfaced via `condition`), so these
      // read-model fields are constant. Retained (constant) until Thread 2 drops them from the web read model.
      blockReason: null,
      acceptableOnJudgeOutage: false,
      // The lane's pre-turn composer-footer default (`model · effort`), keyed off the thread's role.
      defaultFooter: laneDefaultFooter(t.role),
      // Per-role operator-chat toggle (d12) — whether this thread's kind accepts operator input at all. The
      // web gates the chat composer on this (live steerability/halted-retry nuance is a runtime check, not
      // this static per-kind flag).
      operatorInput: threadKindSpec(t.role).operatorInput,
      isMasterReview: t.role === 'master_review',
      // A builder's review CHILD threads (review_agent × N + review_fix) live in the SAME thread group, related by
      // `parent_thread_id`. Each is a first-class row with its own status + findings + streaming lane.
      children:
        t.role === 'builder'
          ? siblings
              .filter(
                (c) =>
                  c.parent_thread_id === t.id &&
                  (c.role === 'review_agent' || c.role === 'review_fix'),
              )
              .map((c) => toPipelineChild(c, t.id))
          : [],
    });

    const mapThreadGroup = (s: ThreadGroupEntity) => {
      const threadGroupThreads = threadsByThreadGroup.get(s.id) ?? [];
      const roots = threadGroupThreads.filter((t) => t.parent_thread_id == null);
      return {
        id: s.id,
        kind: s.kind,
        title: s.title,
        type: s.type,
        ordinal: s.ordinal,
        status: s.status,
        condition: s.condition,
        decisionRecordId: s.decision_record_id,
        threads: roots.map((t) => mapThread(t, threadGroupThreads)),
        tasks: (tasksByThreadGroup.get(s.id) ?? []).map(toTaskItem),
      };
    };

    // The ACTIVE pipeline is the thread groups under the job's current revision (plus the revision-agnostic
    // singletons like planning/plan_review, whose thread group carries a null record). Prior revisions' thread
    // groups are surfaced separately as browsable history.
    const activeRecordId = job.decision_record_id;
    const activeThreadGroups = threadGroups.filter(
      (s) =>
        s.decision_record_id == null || s.decision_record_id === activeRecordId,
    );
    // The PLAN REVIEW as a first-class navigator row (the Codex review dialogue Main communicates with) —
    // derived from the plan_review thread group's single thread's status. Null when no plan_review thread group exists.
    const planReviewThreadGroup = threadGroups.find((s) => s.kind === 'plan_review');
    const planReviewThread = planReviewThreadGroup
      ? (threadsByThreadGroup.get(planReviewThreadGroup.id) ?? [])[0]
      : undefined;
    const planReview = planReviewThread
      ? {
          status: planReviewThread.status,
          // The Codex-review lane's pre-turn footer default ("Codex · xHigh").
          defaultFooter: laneDefaultFooter('plan_review'),
        }
      : null;

    // PRIOR PLAN REVISIONS (browsable, immutable history). Only present once a re-propose over already-DONE
    // work has forged a new revision; the common single-revision job returns `[]`. Revision numbers are
    // derived by `created_at` order (oldest = v1). Only revisions that actually materialized thread groups surface.
    const records = await this.records
      .find({ where: { job_id: job.id }, order: { created_at: 'ASC' } })
      .catch(() => [] as DecisionRecordEntity[]);
    const priorRevisions = records
      .map((rec, i) => ({ rec, revision: i + 1 }))
      .filter(({ rec }) => rec.id !== activeRecordId)
      .map(({ rec, revision }) => ({
        decisionRecordId: rec.id,
        revision,
        status: rec.status,
        threadGroups: threadGroups
          .filter((s) => s.decision_record_id === rec.id)
          .map(mapThreadGroup),
      }))
      .filter((r) => r.threadGroups.length > 0);

    return {
      jobId: job.id,
      title: job.title,
      status: job.status,
      halt: job.halt ?? null,
      createdBy: job.created_by ?? null,
      blockedBy,
      blockedSeedMessage,
      // Which build path was committed at approval: 'direct' (fast, brain-implemented) | 'plan' (driver) |
      // null (never approved). The navigator reads this to hide the plan-oriented empty-state placeholders.
      buildPath: job.build_path ?? null,
      autoApproveMode: job.auto_approve_mode ?? 'off',
      autoMerge: job.auto_merge ?? false,
      // GitHub-mergeable, independent of the auto_merge toggle (a human can always click Merge PR).
      mergeReady: prMergeReady(job),
      mergeValue: prMergeReady(job) ? JSON.stringify({ jobId: job.id }) : null,
      // The plan-review (Codex) thread's presence + live status. Null when no review has run.
      planReview,
      decisionRecordId: job.decision_record_id,
      prUrl: job.pr_url,
      prNumber: job.pr_number,
      // Observed PR lifecycle (`open | merged | closed`) + merge-conflict signal — the SAME reconciler-owned
      // columns the sidebar's PR glyph reads.
      prState: job.pr_state,
      prMergeable: job.pr_mergeable,
      // The observed CI/CD aggregate for the PR head (`success|failure|pending|skipped|null`).
      ciStatus: job.ci_status,
      ciCounts: job.ci_counts,
      featureBranch: job.feature_branch,
      // The OBSERVED live branch (what the agent's HEAD is actually on) — drives the navigator drift badge.
      currentBranch: job.current_branch,
      baseBranch: job.base_branch,
      // The whole pipeline as ordinal-ordered thread groups, each carrying its threads + task checklist.
      threadGroups: activeThreadGroups.map(mapThreadGroup),
      // Prior plan revisions' thread groups as read-only history (empty for the common single-revision job).
      priorRevisions,
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

  // ── thread group / thread / task CRUD (d6/d7 — the orchestration write surface) ───────────────────────

  /** Every thread group of a job, in pipeline order (ORDER BY ordinal). */
  async threadGroupsForJob(jobId: string): Promise<ThreadGroupEntity[]> {
    return this.threadGroups.find({
      where: { job_id: jobId },
      order: { ordinal: 'ASC' },
    });
  }

  /** Every thread of a thread group, in execution order (ORDER BY ordinal). */
  async threadsForThreadGroup(threadGroupId: string): Promise<ThreadEntity[]> {
    return this.threads.find({
      where: { thread_group_id: threadGroupId },
      order: { ordinal: 'ASC' },
    });
  }

  /** Every thread of a thread group as the driver's {@link DriverThread} domain shape, in execution order — the
   *  thread-group-driven drive loop reads this LIVE between builder iterations (a leg rotation appends a fresh
   *  builder row mid-drive, so a start-of-thread-group snapshot goes stale). */
  async driverThreadsForThreadGroup(threadGroupId: string): Promise<DriverThread[]> {
    const rows = await this.threads.find({
      where: { thread_group_id: threadGroupId },
      order: { ordinal: 'ASC' },
    });
    return rows.map(toThread);
  }

  /** How many `builder` threads a thread group holds (its leg count) — the per-thread-group rotation cap reads this to
   *  refuse rotating past {@link MAX_LEGS_PER_THREAD_GROUP}. Keyed off any thread in the thread group (the current
   *  builder's id), so the caller need not carry the thread group id. */
  async builderLegCountForThreadGroup(anchorThreadId: string): Promise<number> {
    const thread = await this.threads.findOne({
      where: { id: anchorThreadId },
      select: { id: true, thread_group_id: true },
    });
    if (!thread) return 0;
    return this.threads.count({
      where: { thread_group_id: thread.thread_group_id, role: 'builder' },
    });
  }

  /** Every task of a thread group's checklist, in display/credit order (ORDER BY ordinal). */
  async tasksForThreadGroup(threadGroupId: string): Promise<TaskEntity[]> {
    return this.tasks.find({
      where: { thread_group_id: threadGroupId },
      order: { ordinal: 'ASC' },
    });
  }

  /**
   * Append a THREAD GROUP at the END of a job's append-only pipeline (d7) — always the next gap-numbered ordinal
   * (`MAX(ordinal)+ORDINAL_GAP`, or `ORDINAL_GAP` for the first). Never renumbers earlier thread groups, so a
   * re-plan round just adds fresh thread groups after the prior ones. {@link appendThreadGroup} is an alias — the
   * "append-only" semantics ARE `createThreadGroup`'s only behavior (there is no insert-in-the-middle).
   */
  async createThreadGroup(input: {
    jobId: string;
    orgId: string;
    kind: string;
    title?: string | null;
    type?: string | null;
    decisionRecordId?: string | null;
    config?: Record<string, unknown>;
  }): Promise<ThreadGroupEntity> {
    const ordinal = (await this.maxThreadGroupOrdinal(input.jobId)) + ORDINAL_GAP;
    return this.threadGroups.save(
      this.threadGroups.create({
        job_id: input.jobId,
        org_id: input.orgId,
        ordinal,
        kind: input.kind,
        title: input.title ?? null,
        type: input.type ?? null,
        decision_record_id: input.decisionRecordId ?? null,
        config: input.config ?? {},
      }),
    );
  }

  /** Alias for {@link createThreadGroup} — the pipeline is append-only, so "append" and "create" are one op. */
  async appendThreadGroup(
    input: Parameters<DriverStoreService['createThreadGroup']>[0],
  ): Promise<ThreadGroupEntity> {
    return this.createThreadGroup(input);
  }

  /** Insert a THREAD into a thread group. Gap-numbers the ordinal within the thread group when omitted. */
  async createThreadInThreadGroup(input: {
    threadGroupId: string;
    jobId: string;
    orgId: string;
    role: string;
    brief: string;
    ordinal?: number;
    type?: string;
    config?: Record<string, unknown>;
    parentThreadId?: string | null;
  }): Promise<ThreadEntity> {
    const ordinal =
      input.ordinal ??
      (await this.maxThreadOrdinal(input.threadGroupId)) + ORDINAL_GAP;
    return this.threads.save(
      this.threads.create({
        thread_group_id: input.threadGroupId,
        job_id: input.jobId,
        org_id: input.orgId,
        role: input.role,
        brief: input.brief,
        ordinal,
        ...(input.type != null ? { type: input.type } : {}),
        config: input.config ?? {},
        parent_thread_id: input.parentThreadId ?? null,
      }),
    );
  }

  /**
   * Find (or lazily create) the job's `post_build` thread group — the isolated, fresh ship-gate session that
   * summarizes the build, proposes preview, and owns amend work off the planning brain's session. Idempotent/reusable:
   * a matching thread group is re-looked-up rather than duplicated. Scoped by `decision_record_id IS NOT DISTINCT FROM`
   * so the nullable FK matches by value (plain SQL equality drops NULL rows).
   */
  async ensurePostBuildThread(input: {
    jobId: string;
    orgId: string;
    decisionRecordId: string | null;
  }): Promise<{ threadGroupId: string; threadId: string }> {
    const threadGroup = await this.threadGroups
      .createQueryBuilder('s')
      .where('s.job_id = :jobId', { jobId: input.jobId })
      .andWhere('s.kind = :kind', { kind: 'post_build' })
      .andWhere('s.decision_record_id IS NOT DISTINCT FROM :decisionRecordId', {
        decisionRecordId: input.decisionRecordId,
      })
      .orderBy('s.ordinal', 'ASC')
      .getOne();
    if (threadGroup) {
      const [thread] = await this.threadsForThreadGroup(threadGroup.id);
      if (thread) return { threadGroupId: threadGroup.id, threadId: thread.id };
    }
    const created =
      threadGroup ??
      (await this.createThreadGroup({
        jobId: input.jobId,
        orgId: input.orgId,
        kind: 'post_build',
        decisionRecordId: input.decisionRecordId,
        title: null,
        type: null,
      }));
    const thread = await this.createThreadInThreadGroup({
      threadGroupId: created.id,
      jobId: input.jobId,
      orgId: input.orgId,
      role: 'post_build',
      brief: 'Ship gate — review and amend',
      ordinal: await this.nextRootThreadOrdinal(input.jobId),
    });
    return { threadGroupId: created.id, threadId: thread.id };
  }

  /**
   * Find (or lazily create) the job's `ci` thread group — the post-ship seam (d14). Created just before the
   * PR-ready state is published (`setPrReady`); starts with `session_id = null`
   * (a fresh session, isolated from planning) and
   * sits idle (`ci` is a render-only, session-backed role — see `thread-kind/registry.ts`) until inbound
   * GitHub/CI events are routed to it. Once this thread exists, `StimulusStoreService.attachEventToJob`
   * (via `JobBootstrapService.ciThreadId`, a read-only lookup) stamps `lane=thread:<ciThreadId>` on the
   * event stimulus so `AgentSessionManager.deliverEventViaFreshTurn` resumes THIS thread's own session
   * instead of planning's (`/context/specs/sections/04-messaging-chat.md` §CI-routing). Idempotent:
   * `setPrReady` may be reached more than once for a job (the driver path, the reconciler, and the GitHub
   * webhook fast path all call it), so a matching thread group is re-looked-up rather than duplicated.
   */
  async ensureCiThread(input: {
    jobId: string;
    orgId: string;
    decisionRecordId: string | null;
  }): Promise<{ threadGroupId: string; threadId: string }> {
    const threadGroup = await this.threadGroups
      .createQueryBuilder('s')
      .where('s.job_id = :jobId', { jobId: input.jobId })
      .andWhere('s.kind = :kind', { kind: 'ci' })
      .andWhere('s.decision_record_id IS NOT DISTINCT FROM :decisionRecordId', {
        decisionRecordId: input.decisionRecordId,
      })
      .orderBy('s.ordinal', 'ASC')
      .getOne();
    if (threadGroup) {
      const [thread] = await this.threadsForThreadGroup(threadGroup.id);
      if (thread) return { threadGroupId: threadGroup.id, threadId: thread.id };
    }
    const created =
      threadGroup ??
      (await this.createThreadGroup({
        jobId: input.jobId,
        orgId: input.orgId,
        kind: 'ci',
        decisionRecordId: input.decisionRecordId,
        title: null,
        type: null,
      }));
    const thread = await this.createThreadInThreadGroup({
      threadGroupId: created.id,
      jobId: input.jobId,
      orgId: input.orgId,
      role: 'ci',
      brief: 'CI — post-ship checks',
      ordinal: await this.nextRootThreadOrdinal(input.jobId),
    });
    return { threadGroupId: created.id, threadId: thread.id };
  }

  /** Read a thread's live engine session id (d5 — `session_id` moved onto the thread row). */
  async threadSessionId(threadId: string): Promise<string | null> {
    const row = await this.threads.findOne({
      where: { id: threadId },
      select: { id: true, session_id: true },
    });
    return row?.session_id ?? null;
  }

  /** Persist a thread's live engine session id (d5). */
  async setThreadSessionId(threadId: string, sessionId: string): Promise<void> {
    await this.threads.update({ id: threadId }, { session_id: sessionId });
  }

  /** Read-only lookup of the job's `post_build` thread-group thread id (the re-homed session for preview/amend
   *  seeds), or null when the gate hasn't spawned it yet. Latest by ordinal, mirroring `ciThreadId`. */
  async postBuildThreadId(jobId: string): Promise<string | null> {
    const row = await this.threads.findOne({
      where: { job_id: jobId, role: 'post_build' },
      order: { ordinal: 'DESC' },
      select: { id: true },
    });
    return row?.id ?? null;
  }

  /** The thread's role (registry-backed `ThreadRole`), or null if the thread is gone. The turn seam uses
   *  this to resolve WHICH stage persona (`threadKindSpec(role).agent`) a re-homed turn runs as. */
  async threadRole(threadId: string): Promise<ThreadRole | null> {
    const row = await this.threads.findOne({
      where: { id: threadId },
      select: { id: true, role: true },
    });
    return row ? coerceThreadRole(row.role) : null;
  }

  /** Insert a TASK into a thread group's checklist. Dense-numbers the ordinal (which doubles as the short
   *  `#N` task id) within the thread group when omitted. */
  async createTask(input: {
    threadGroupId: string;
    orgId: string;
    title: string;
    brief?: string | null;
    activeForm?: string | null;
    ordinal?: number;
    blockedBy?: string[];
  }): Promise<TaskEntity> {
    const ordinal =
      input.ordinal ?? (await this.maxTaskOrdinal(input.threadGroupId)) + 1;
    return this.tasks.save(
      this.tasks.create({
        thread_group_id: input.threadGroupId,
        org_id: input.orgId,
        title: input.title,
        brief: input.brief ?? null,
        active_form: input.activeForm ?? null,
        ordinal,
        blocked_by: input.blockedBy ?? [],
      }),
    );
  }

  /** Set a task's status (`pending | in_progress | completed | dropped`). */
  async updateTaskStatus(taskId: string, status: string): Promise<void> {
    await this.tasks.update({ id: taskId }, { status });
  }

  /**
   * The job's planning thread group thread id — the anchor for JOB-LEVEL card messages (question/ship/amend/merge
   * cards) that have no build-lane thread of their own. Mirrors d3's backfill fallback ("orphans default to
   * the job's planning thread") now that `messages.thread_id` is NOT NULL. Every job gets exactly one
   * planning thread group with one thread at job start (d7), so this should always resolve for a job already past
   * `open`; throws loudly rather than inserting a message with a null/bogus thread_id if it somehow doesn't.
   */
  private async planningThreadId(jobId: string): Promise<string> {
    const threadGroup = await this.threadGroups.findOne({
      where: { job_id: jobId, kind: 'planning' },
      order: { ordinal: 'ASC' },
    });
    const thread = threadGroup
      ? await this.threads.findOne({
          where: { thread_group_id: threadGroup.id },
          order: { ordinal: 'ASC' },
        })
      : null;
    if (!thread) {
      throw new Error(
        `driver-store: job ${jobId} has no planning thread group thread to anchor a card message`,
      );
    }
    return thread.id;
  }

  private async maxThreadGroupOrdinal(jobId: string): Promise<number> {
    const row = await this.threadGroups
      .createQueryBuilder('s')
      .select('MAX(s.ordinal)', 'max')
      .where('s.job_id = :jobId', { jobId })
      .getRawOne<{ max: number | null }>();
    return row?.max ?? 0;
  }

  private async maxThreadOrdinal(threadGroupId: string): Promise<number> {
    const row = await this.threads
      .createQueryBuilder('t')
      .select('MAX(t.ordinal)', 'max')
      .where('t.thread_group_id = :threadGroupId', { threadGroupId })
      .getRawOne<{ max: number | null }>();
    return row?.max ?? 0;
  }

  /** The next job-GLOBAL ordinal for a ROOT thread (`parent_thread_id IS NULL`). Root threads share the
   *  job-wide `uq_threads_job_parent_ordinal` (job_id, parent_thread_id, ordinal) NULLS NOT DISTINCT index,
   *  so a lazily-created thread group (post_build/ci) must gap-number off the highest existing root ordinal
   *  — NOT its own (always-empty) new thread group, which would always yield ORDINAL_GAP and collide with the
   *  planning thread / a sibling post-build thread group. Mirrors `persistPlan`'s root-ordinal allocation. */
  private async nextRootThreadOrdinal(jobId: string): Promise<number> {
    const row = await this.threads
      .createQueryBuilder('t')
      .select('MAX(t.ordinal)', 'max')
      .where('t.job_id = :jobId', { jobId })
      .andWhere('t.parent_thread_id IS NULL')
      .getRawOne<{ max: number | null }>();
    return (row?.max ?? 0) + ORDINAL_GAP;
  }

  private async maxTaskOrdinal(threadGroupId: string): Promise<number> {
    const row = await this.tasks
      .createQueryBuilder('t')
      .select('MAX(t.ordinal)', 'max')
      .where('t.thread_group_id = :threadGroupId', { threadGroupId })
      .getRawOne<{ max: number | null }>();
    return row?.max ?? 0;
  }

  // ── routing ──────────────────────────────────────────────────────────────────────────────────

  /** Resolve where to post a thread's chatter: the repo coordinate + the real thread id. */
  async route(thread: Job): Promise<JobRoute> {
    return { channel: thread.repoId, threadTs: thread.id, orgId: thread.orgId };
  }
}

// ── row ⇄ domain mappers ─────────────────────────────────────────────────────────────────────────

/** Group a flat row list by a key selector, preserving input order within each bucket. */
function groupBy<T, K>(list: readonly T[], key: (item: T) => K): Map<K, T[]> {
  const out = new Map<K, T[]>();
  for (const item of list) {
    const k = key(item);
    const bucket = out.get(k);
    if (bucket) bucket.push(item);
    else out.set(k, [item]);
  }
  return out;
}

/** Map a thread-group-owned {@link TaskEntity} row back to the `TaskItem` wire/domain shape. The surfaced id
 *  is the short per-stage `#N` (the row's dense `ordinal`), not the uuid PK — this is the read path that
 *  feeds `getPipelineState`/`getThreadTasks` and, through them, the web sidebar. */
function toTaskItem(row: TaskEntity): TaskItem {
  return {
    id: String(row.ordinal),
    subject: row.title,
    status: row.status as TaskItem['status'],
    ...(row.brief != null ? { description: row.brief } : {}),
    ...(row.active_form != null ? { activeForm: row.active_form } : {}),
    ...(row.blocked_by?.length ? { blockedBy: row.blocked_by } : {}),
  };
}

/** Map a driver `StepStatus` onto the owning thread's `status` cursor (the synthetic step IS the thread). */
function stepStatusToThreadStatus(status: StepStatus): ThreadStatus {
  switch (status) {
    case 'building':
      return 'executing';
    case 'reviewing':
      return 'reviewing';
    case 'done':
      return 'done';
    default:
      return 'pending';
  }
}

/** Map a thread's `status` onto the synthetic step's `StepStatus` (the inverse of the above). */
function threadStatusToStepStatus(status: string): StepStatus {
  switch (status) {
    case 'done':
      return 'done';
    case 'executing':
      return 'building';
    case 'reviewing':
    case 'auto_fixing':
      return 'reviewing';
    default:
      return 'pending';
  }
}

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
    buildPath: row.build_path,
    status: row.status as JobStatus,
    activity: row.activity,
    halt: row.halt ?? null,
    decisionRecordId: row.decision_record_id,
    featureBranch: row.feature_branch,
    currentBranch: row.current_branch,
    prUrl: row.pr_url,
    prNumber: row.pr_number,
    shipReviewApprovedAt: row.ship_review_approved_at,
    autoApproveMode: row.auto_approve_mode ?? 'off',
    autoApproveBy: row.auto_approve_by ?? null,
    autoMerge: row.auto_merge ?? false,
    autoMergeBy: row.auto_merge_by ?? null,
    createdBy: row.created_by ?? null,
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
    kind: row.role,
    threadGroupId: row.thread_group_id,
    type: coerceThreadType(row.type),
    parentThreadId: row.parent_thread_id ?? null,
    startSha: row.start_sha ?? null,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

function isSkillNudge(value: unknown): value is SkillNudge {
  if (!isRecord(value) || !Array.isArray(value.skills)) return false;
  if (typeof value.at !== 'string') return false;
  return value.skills.every(
    (s) =>
      isRecord(s) && typeof s.name === 'string' && typeof s.reason === 'string',
  );
}

function toReviewChild(row: ThreadEntity): ReviewChildThread {
  return {
    id: row.id,
    kind: row.role,
    brief: row.brief,
    ordinal: row.ordinal,
    config: (row.config as Record<string, unknown>) ?? {},
    status: row.status as ThreadStatus,
    condition: (row.condition as ThreadCondition) ?? 'none',
    reviewFindings: Array.isArray(row.review_findings)
      ? row.review_findings
      : null,
  };
}

/** The `/pipeline` wire shape of a builder's review child (a `review_agent` / `review_fix`). */
interface PipelineReviewChild {
  id: string;
  role: string;
  brief: string;
  status: string;
  condition: string;
  lensId?: string;
  findings: number | null;
  lane: string;
  /** The lane's pre-turn composer-footer default (`model · effort`), keyed off the child's role. */
  defaultFooter: ReturnType<typeof laneDefaultFooter>;
}

/**
 * Map a materialized review CHILD row (`review_agent` / `review_fix`) to the `/pipeline` wire shape: its id +
 * role + status + (for a lens) its `lensId`/finding count, plus the streaming lane the web renders it on —
 * `autofix:<parentId>:<lensId>` for a lens, `autofix:<parentId>:fix` for the fix pass (the SAME lanes the
 * turns stream on). The web uses these as bare child-thread nodes (no synthetic `rev:`/`fix:` ids).
 */
function toPipelineChild(
  c: ThreadEntity,
  parentId: string,
): PipelineReviewChild {
  const lensId = (c.config as { lensId?: string })?.lensId;
  return {
    id: c.id,
    role: c.role,
    brief: c.brief,
    status: c.status,
    condition: c.condition,
    ...(lensId ? { lensId } : {}),
    findings: Array.isArray(c.review_findings)
      ? c.review_findings.length
      : null,
    lane:
      c.role === 'review_agent'
        ? laneFor('autofix-lens', parentId, lensId ?? 'review')
        : laneFor('autofix-fix', parentId),
    defaultFooter: laneDefaultFooter(c.role),
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
