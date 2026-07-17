import { Injectable } from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import type {
  Decision,
  DecisionRecord,
  Job,
  JobActivity,
  JobHalt,
  JobStatus,
  Step,
  StepStatus,
  Thread,
  ThreadCondition,
  ThreadStatus,
} from '@shared/domain';
import type { AgentMessage } from '@shared/prompt-kit/message';
import { coerceThreadType } from '@shared/thread-kind/thread-types';
import { randomUUID } from 'node:crypto';
import { DataSource, In, IsNull, MoreThan, Raw, Repository } from 'typeorm';
import type { ReviewFinding } from '../autofix/autofix.types';
import { JobDependencyService } from '../job-deps/job-dependency.service';
import { DB_CONNECTION } from '../persistence/database.module';
import type {
  DeviationEntry,
  SessionAnchor,
  TaskItem,
  ThreadTerminalRecord,
} from '../persistence/entities';
import {
  DecisionRecordEntity,
  JobEntity,
  TaskEntity,
  ThreadEntity,
  ThreadGroupEntity,
  TranscriptMessageEntity,
} from '../persistence/entities';
import { writeSystemChunk } from '../persistence/system-chunk-writer';
import type { PlannedStep } from '../prompt-kit/messages/render-plan';
import { StimulusStoreService } from '../stimulus/stimulus-store.service';
import { laneFor } from '../surface/thread-registry';
import {
  webAmendProposalCard,
  webMergeReadyCard,
  webVerdictCard,
} from '../surface/web-approval-card';
import type { WebQuestionCard } from '../surface/web-question-card';
import { ThreadRole } from '../thread-kind/__tests__/spec';
import { coerceThreadRole, laneDefaultFooter, threadKindSpec } from '../thread-kind/registry';
import { prMergeReady } from './auto-merge.service';

const ORDINAL_GAP = 10;

export type DriverThread = Thread & { orgId: string };

export type SkillNudge = {
  skills: { name: string; reason: string }[];
  at: string;
};

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

export interface JobRoute {
  channel: string | null;
  threadTs: string | null;
  orgId?: string;
}

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
    private readonly stimulusStore: StimulusStoreService,
  ) {}


  async findOpenOperatorInputCard(
    jobId: string,
  ): Promise<{ questionId: string; question: string } | null> {
    const rows = await this.messages.find({
      where: { job_id: jobId, kind: 'card' },
      order: { created_at: 'DESC' },
    });
    for (const row of rows) {
      const card = row.card as unknown as WebQuestionCard | undefined;
      if (card?.type === 'question_card' && card.origin === 'build' && card.answer == null) {
        return { questionId: card.questionId, question: card.question };
      }
    }
    return null;
  }

  async openOperatorInputCard(jobId: string, question: string): Promise<{ questionId: string }> {
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

  async readOperatorInputAnswer(jobId: string, questionId: string): Promise<string | null> {
    const row = await this.messages.findOne({
      where: { job_id: jobId, ts: questionId, kind: 'card' },
    });
    const card = row?.card as unknown as WebQuestionCard | undefined;
    return card?.type === 'question_card' ? (card.answer ?? null) : null;
  }

  async markOperatorInputDelivered(jobId: string, questionId: string): Promise<void> {
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


  async loadJob(jobId: string): Promise<Job> {
    return toJob(await this.jobs.findOneOrFail({ where: { id: jobId } }));
  }

  async ownerUserId(orgId: string): Promise<string | null> {
    const rows = await this.dataSource.query<{ user_id: string }[]>(
      `SELECT user_id FROM organization_members WHERE org_id = $1 AND role = 'owner' ORDER BY created_at ASC LIMIT 1`,
      [orgId],
    );
    return rows[0]?.user_id ?? null;
  }

  async runningJobs(): Promise<Job[]> {
    const rows = await this.jobs.find({
      where: {
        status: 'running',
        halt: IsNull(),
        session_resume_at: Raw((alias) => `(${alias} IS NULL OR ${alias} <= now())`),
      },
    });
    return rows.map(toJob);
  }

  async setJobStatus(jobId: string, status: JobStatus): Promise<void> {
    await this.jobs.update({ id: jobId }, { status });
  }

  async setActivity(jobId: string, activity: JobActivity): Promise<void> {
    await this.jobs.update({ id: jobId }, { activity });
  }

  async recomputeBuildStageProgress(jobId: string): Promise<void> {
    const job = await this.jobs.findOne({ where: { id: jobId } });
    const activeRecordId = job?.decision_record_id ?? null;
    const groups = await this.threadGroups.find({ where: { job_id: jobId } });
    const buildGroups = groups.filter(
      (g) =>
        (g.kind === 'build' || g.kind === 'direct_build') &&
        (activeRecordId ? g.decision_record_id === activeRecordId : g.decision_record_id == null),
    );
    const total = buildGroups.length;
    const builderFinished = (s: string) => s === 'done' || s === 'auto_fixing';
    let done = 0;
    for (const g of buildGroups) {
      const builders = await this.threads.find({
        where: { thread_group_id: g.id, role: 'builder' },
        select: { id: true, status: true },
      });
      if (builders.length > 0 && builders.every((t) => builderFinished(t.status))) done += 1;
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

  async setJobHalt(jobId: string, halt: JobHalt): Promise<void> {
    await this.jobs.update({ id: jobId }, { halt, activity: 'idle' });
  }

  async clearJobHalt(jobId: string): Promise<void> {
    await this.jobs.update({ id: jobId }, { halt: null });
  }

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
      (m) => (m.meta as { source?: unknown } | null)?.source === 'system_operator',
    );
  }

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

  async clearRetrySessionResume(jobId: string, lane: 'main' | 'build'): Promise<void> {
    await this.jobs
      .createQueryBuilder()
      .update(JobEntity)
      .set({ session_resume_at: null, session_resume: null })
      .where('id = :jobId', { jobId })
      .andWhere("session_resume->>'kind' = 'retry'")
      .andWhere("session_resume->>'lane' = :lane", { lane })
      .execute();
  }

  async setFeatureBranch(jobId: string, branch: string): Promise<void> {
    await this.jobs.update({ id: jobId }, { feature_branch: branch });
  }

  async setCurrentBranch(jobId: string, branch: string | null): Promise<void> {
    await this.jobs.update({ id: jobId }, { current_branch: branch });
  }


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
    if (parked) {
      await this.ensurePostBuildThread({ jobId, orgId, decisionRecordId });
    }
    return parked;
  }

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

  async openAmendProposal(
    jobId: string,
    reason: string,
  ): Promise<'posted' | 'not-parked' | 'already-open'> {
    return this.dataSource.transaction(async (m) => {
      const job = await m.getRepository(JobEntity).findOne({ where: { id: jobId } });
      if (!job || job.status !== 'awaiting_ship_review') return 'not-parked';
      const messages = m.getRepository(TranscriptMessageEntity);
      const existing = await messages.find({
        where: { job_id: jobId, ts: `amend-proposal:${jobId}`, kind: 'card' },
      });
      if (
        existing.some(
          (row) => (row.card as Record<string, unknown> | null)?.['type'] === 'approval_card',
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
          card: webAmendProposalCard({ jobId, reason }) as unknown as Record<string, unknown>,
        }),
      );
      return 'posted';
    });
  }

  async neutralizeAmendProposal(jobId: string, verdictLine: string): Promise<void> {
    const rows = await this.messages.find({
      where: { job_id: jobId, ts: `amend-proposal:${jobId}`, kind: 'card' },
    });
    for (const row of rows) {
      const card = row.card as Record<string, unknown> | null;
      if (card?.['type'] !== 'approval_card') continue;
      const title = String(card?.['title'] ?? 'Amend build?');
      const verdict = verdictLine.toLowerCase().includes('dismiss') ? 'dismissed' : 'approved';
      row.card = webVerdictCard(jobId, title, verdict, verdictLine) as unknown as Record<
        string,
        unknown
      >;
      await this.messages.save(row);
    }
  }


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
    row.card = webVerdictCard(jobId, title, verdict, verdictLine) as unknown as Record<
      string,
      unknown
    >;
    await this.messages.save(row);
  }

  async clearShipApproval(jobId: string): Promise<void> {
    await this.jobs.update({ id: jobId }, { ship_review_approved_at: null });
  }

  async setPrReady(jobId: string, prUrl: string, prNumber?: number): Promise<void> {
    await this.jobs.update(
      { id: jobId },
      {
        pr_url: prUrl,
        ...(prNumber != null ? { pr_number: prNumber } : {}),
        status: 'done',
        activity: 'idle',
        pr_state: 'open',
      },
    );
  }


  async decisionRecord(decisionRecordId: string | null): Promise<DecisionRecord | null> {
    if (!decisionRecordId) return null;
    const row = await this.records.findOne({ where: { id: decisionRecordId } });
    return row ? toRecord(row) : null;
  }


  async threadsForJob(jobId: string): Promise<DriverThread[]> {
    const job = await this.jobs.findOne({ where: { id: jobId } });
    const activeRecordId = job?.decision_record_id ?? null;
    const qb = this.threads
      .createQueryBuilder('t')
      .innerJoin(ThreadGroupEntity, 's', 's.id = t.thread_group_id')
      .where('t.job_id = :jobId', { jobId })
      .orderBy('t.ordinal', 'ASC');
    if (activeRecordId) qb.andWhere('s.decision_record_id = :activeRecordId', { activeRecordId });
    else qb.andWhere('s.decision_record_id IS NULL');
    const rows = await qb.getMany();
    return rows.map(toThread);
  }

  async setThreadStatus(threadId: string, status: ThreadStatus): Promise<void> {
    await this.threads.update({ id: threadId }, { status });
  }

  async setThreadCondition(threadId: string, condition: ThreadCondition): Promise<void> {
    await this.threads.update({ id: threadId }, { condition });
  }

  async ensureThreadStartSha(threadId: string, candidate: string): Promise<string> {
    await this.threads.update({ id: threadId, start_sha: IsNull() }, { start_sha: candidate });
    const row = await this.threads.findOne({ where: { id: threadId } });
    return row?.start_sha ?? candidate;
  }


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
      typeof config.contextTokensPeak === 'number' ? config.contextTokensPeak : null;
    const nextPeak = contextTokensPeak != null ? Math.max(priorPeak ?? 0, contextTokensPeak) : null;
    const patch = {
      ...(sessionId != null ? { session_id: sessionId } : {}),
      ...(nextPeak != null ? { config: { ...config, contextTokensPeak: nextPeak } } : {}),
    };
    if (Object.keys(patch).length === 0) return;
    await this.threads.update({ id: anchorStepId }, patch);
  }

  async readGroupSkillNudge(threadGroupId: string): Promise<SkillNudge | null> {
    const g = await this.threadGroups.findOne({
      where: { id: threadGroupId },
      select: { id: true, config: true },
    });
    const v = isRecord(g?.config) ? g!.config.skillNudge : undefined;
    return isSkillNudge(v) ? v : null;
  }

  async persistGroupSkillNudge(threadGroupId: string, nudge: SkillNudge): Promise<void> {
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

  async recordBuildSystemChunk(input: {
    jobId: string;
    phaseId: string;
    legOrdinal: number;
    kind: 'system_notice' | 'system_reminder';
    text: AgentMessage;
    chunkKey: string;
    reminderKind?: string;
  }): Promise<void> {
    await writeSystemChunk(
      this.messages,
      {
        jobId: input.jobId,
        threadId: input.phaseId,
        kind: input.kind,
        text: input.text,
        chunkKey: input.chunkKey,
        reminderKind: input.reminderKind,
      },
      { phaseId: input.phaseId, legOrdinal: input.legOrdinal },
    );
  }

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

  async getPendingLegSeed(anchorStepId: string): Promise<string | null> {
    const thread = await this.threads.findOne({
      where: { id: anchorStepId },
      select: { id: true, config: true },
    });
    const seed = isRecord(thread?.config) ? thread!.config.pendingLegSeed : null;
    return typeof seed === 'string' ? seed : null;
  }

  async getThreadTasks(threadId: string): Promise<TaskItem[]> {
    const thread = await this.threads.findOne({
      where: { id: threadId },
      select: { id: true, thread_group_id: true },
    });
    if (!thread) return [];
    const rows = await this.tasksForThreadGroup(thread.thread_group_id);
    return rows.map(toTaskItem);
  }

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
      .where('thread_group_id = :threadGroupId', {
        threadGroupId: thread.thread_group_id,
      })
      .andWhere("status IN ('pending', 'in_progress')")
      .execute();
    return res.affected ?? 0;
  }

  async getThread(threadId: string): Promise<DriverThread | null> {
    const row = await this.threads.findOne({ where: { id: threadId } });
    return row ? toThread(row) : null;
  }

  async setThreadPlan(threadId: string, plan: string, handoffIn: string | null): Promise<void> {
    await this.threads.update({ id: threadId }, { plan, handoff_in: handoffIn });
  }

  async setThreadOrientation(threadId: string, orientation: string): Promise<void> {
    await this.threads.update({ id: threadId }, { orientation });
  }

  async setThreadHandoffOut(threadId: string, handoffOut: string): Promise<void> {
    await this.threads.update({ id: threadId }, { handoff_out: handoffOut });
  }

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


  async recordThreadTermination(threadId: string, record: ThreadTerminalRecord): Promise<void> {
    await this.threads.update({ id: threadId }, { terminal_record: record });
  }

  async clearTerminalRecord(threadId: string): Promise<void> {
    await this.threads.update({ id: threadId }, { terminal_record: null });
  }

  async getTerminalRecord(threadId: string): Promise<ThreadTerminalRecord | null> {
    const row = await this.threads.findOne({
      where: { id: threadId },
      select: { id: true, terminal_record: true },
    });
    return row?.terminal_record ?? null;
  }


  async threadJobId(threadId: string): Promise<string | null> {
    const row = await this.threads.findOne({
      where: { id: threadId },
      select: { id: true, job_id: true },
    });
    return row?.job_id ?? null;
  }

  async masterReviewThreadId(jobId: string): Promise<string | null> {
    const row = await this.threads.findOne({
      where: { job_id: jobId, role: 'master_review' },
      select: { id: true },
    });
    return row?.id ?? null;
  }

  async claimAuthRetryAttempt(jobId: string, cap: number): Promise<{ ok: boolean; used: number }> {
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

  async claimSessionLimitTextMisfire(
    jobId: string,
    cap: number,
  ): Promise<{ ok: boolean; used: number }> {
    const res = await this.jobs
      .createQueryBuilder()
      .update(JobEntity)
      .set({
        session_limit_text_misfires: () => 'session_limit_text_misfires + 1',
      })
      .where('id = :jobId', { jobId })
      .andWhere('session_limit_text_misfires < :cap', { cap })
      .returning('session_limit_text_misfires')
      .execute();
    const used = res.raw?.[0]?.session_limit_text_misfires as number | undefined;
    return used != null ? { ok: true, used } : { ok: false, used: cap };
  }

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

  async reviewChildren(parentId: string): Promise<ReviewChildThread[]> {
    const rows = await this.threads.find({
      where: { parent_thread_id: parentId },
      order: { ordinal: 'ASC' },
    });
    return rows.map(toReviewChild);
  }

  async setThreadReviewFindings(threadId: string, findings: ReviewFinding[]): Promise<void> {
    await this.threads.update({ id: threadId }, { review_findings: findings });
  }


  async stepsForThread(threadId: string): Promise<Step[]> {
    const thread = await this.threads.findOne({ where: { id: threadId } });
    if (!thread) return [];
    return [await this.toSyntheticStep(thread)];
  }

  async resolveSessionAnchor(threadId: string): Promise<SessionAnchor | undefined> {
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

  async lockSteps(thread: DriverThread, _planned: PlannedStep[]): Promise<Step[]> {
    return this.stepsForThread(thread.id);
  }

  async setStepState(stepId: string, _stage: string, status: StepStatus): Promise<void> {
    await this.threads.update({ id: stepId }, { status: stepStatusToThreadStatus(status) });
  }

  async setStepCommit(stepId: string, commitSha: string): Promise<void> {
    await this.threads.update({ id: stepId }, { commit_sha: commitSha });
  }

  async setBatchOrdinals(_assignments: Array<[string, number]>): Promise<void> {
  }

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


  async getPipelineState(jobId: string, orgId: string): Promise<unknown> {
    const job = await this.jobs.findOne({
      where: { id: jobId, org_id: orgId },
    });
    if (!job) return { status: 'no_job' };
    const blockedBy = job.status === 'blocked' ? await this.jobDeps.blockersOf(jobId) : [];
    const blockedSeedMessage =
      job.status === 'blocked' ? await this.stimulusStore.pendingBlockedPreview(jobId) : null;
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
        mainDefaultFooter: laneDefaultFooter('planning'),
        createdBy: job.created_by ?? null,
        autoApproveMode: job.auto_approve_mode ?? 'off',
        autoMerge: job.auto_merge ?? false,
        mergeReady: prMergeReady(job),
        mergeValue: prMergeReady(job) ? JSON.stringify({ jobId: job.id }) : null,
        blockedBy,
        blockedSeedMessage,
      };
    }
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
      blockReason: null,
      acceptableOnJudgeOutage: false,
      defaultFooter: laneDefaultFooter(t.role),
      operatorInput: threadKindSpec(t.role).operatorInput,
      isMasterReview: t.role === 'master_review',
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

    const activeRecordId = job.decision_record_id;
    const activeThreadGroups = threadGroups.filter(
      (s) => s.decision_record_id == null || s.decision_record_id === activeRecordId,
    );
    const planReviewThreadGroup = threadGroups.find((s) => s.kind === 'plan_review');
    const planReviewThread = planReviewThreadGroup
      ? (threadsByThreadGroup.get(planReviewThreadGroup.id) ?? [])[0]
      : undefined;
    const planReview = planReviewThread
      ? {
          status: planReviewThread.status,
          defaultFooter: laneDefaultFooter('plan_review'),
        }
      : null;

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
      buildPath: job.build_path ?? null,
      autoApproveMode: job.auto_approve_mode ?? 'off',
      autoMerge: job.auto_merge ?? false,
      mergeReady: prMergeReady(job),
      mergeValue: prMergeReady(job) ? JSON.stringify({ jobId: job.id }) : null,
      planReview,
      decisionRecordId: job.decision_record_id,
      prUrl: job.pr_url,
      prNumber: job.pr_number,
      prState: job.pr_state,
      prMergeable: job.pr_mergeable,
      ciStatus: job.ci_status,
      ciCounts: job.ci_counts,
      featureBranch: job.feature_branch,
      currentBranch: job.current_branch,
      baseBranch: job.base_branch,
      threadGroups: activeThreadGroups.map(mapThreadGroup),
      priorRevisions,
    };
  }

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


  async threadGroupsForJob(jobId: string): Promise<ThreadGroupEntity[]> {
    return this.threadGroups.find({
      where: { job_id: jobId },
      order: { ordinal: 'ASC' },
    });
  }

  async threadsForThreadGroup(threadGroupId: string): Promise<ThreadEntity[]> {
    return this.threads.find({
      where: { thread_group_id: threadGroupId },
      order: { ordinal: 'ASC' },
    });
  }

  async driverThreadsForThreadGroup(threadGroupId: string): Promise<DriverThread[]> {
    const rows = await this.threads.find({
      where: { thread_group_id: threadGroupId },
      order: { ordinal: 'ASC' },
    });
    return rows.map(toThread);
  }

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

  async tasksForThreadGroup(threadGroupId: string): Promise<TaskEntity[]> {
    return this.tasks.find({
      where: { thread_group_id: threadGroupId },
      order: { ordinal: 'ASC' },
    });
  }

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

  async appendThreadGroup(
    input: Parameters<DriverStoreService['createThreadGroup']>[0],
  ): Promise<ThreadGroupEntity> {
    return this.createThreadGroup(input);
  }

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
      input.ordinal ?? (await this.maxThreadOrdinal(input.threadGroupId)) + ORDINAL_GAP;
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

  async threadSessionId(threadId: string): Promise<string | null> {
    const row = await this.threads.findOne({
      where: { id: threadId },
      select: { id: true, session_id: true },
    });
    return row?.session_id ?? null;
  }

  async setThreadSessionId(threadId: string, sessionId: string): Promise<void> {
    await this.threads.update({ id: threadId }, { session_id: sessionId });
  }

  async postBuildThreadId(jobId: string): Promise<string | null> {
    const row = await this.threads.findOne({
      where: { job_id: jobId, role: 'post_build' },
      order: { ordinal: 'DESC' },
      select: { id: true },
    });
    return row?.id ?? null;
  }

  async threadRole(threadId: string): Promise<ThreadRole | null> {
    const row = await this.threads.findOne({
      where: { id: threadId },
      select: { id: true, role: true },
    });
    return row ? coerceThreadRole(row.role) : null;
  }

  async createTask(input: {
    threadGroupId: string;
    orgId: string;
    title: string;
    brief?: string | null;
    activeForm?: string | null;
    ordinal?: number;
    blockedBy?: string[];
  }): Promise<TaskEntity> {
    const ordinal = input.ordinal ?? (await this.maxTaskOrdinal(input.threadGroupId)) + 1;
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

  async updateTaskStatus(taskId: string, status: string): Promise<void> {
    await this.tasks.update({ id: taskId }, { status });
  }

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


  async route(thread: Job): Promise<JobRoute> {
    return { channel: thread.repoId, threadTs: thread.id, orgId: thread.orgId };
  }
}


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
    (s) => isRecord(s) && typeof s.name === 'string' && typeof s.reason === 'string',
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
    reviewFindings: Array.isArray(row.review_findings) ? row.review_findings : null,
  };
}

interface PipelineReviewChild {
  id: string;
  role: string;
  brief: string;
  status: string;
  condition: string;
  lensId?: string;
  findings: number | null;
  lane: string;
  defaultFooter: ReturnType<typeof laneDefaultFooter>;
}

function toPipelineChild(c: ThreadEntity, parentId: string): PipelineReviewChild {
  const lensId = (c.config as { lensId?: string })?.lensId;
  return {
    id: c.id,
    role: c.role,
    brief: c.brief,
    status: c.status,
    condition: c.condition,
    ...(lensId ? { lensId } : {}),
    findings: Array.isArray(c.review_findings) ? c.review_findings.length : null,
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
