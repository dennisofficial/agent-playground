import { Injectable, Logger, Optional } from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import type { AutoApproveMode } from '@workspace/shared';
import { DataSource, In, IsNull, MoreThan, Not, type ObjectLiteral, Repository } from 'typeorm';
import type { Decision, Job, JobActivity, JobKind, JobStatus } from '../../_shared/domain';
import { nextDecisionId } from '../../_shared/domain';
import type { AgentMessage } from '../../_shared/prompt-kit/message';
import { coerceThreadType } from '../../_shared/thread-kind/thread-types';
import { JobBootstrapService } from '../job-bootstrap/job-bootstrap.service';
import { JobDependencyService } from '../job-deps/job-dependency.service';
import { DB_CONNECTION } from '../persistence/database.module';
import {
  DecisionRecordEntity,
  InboundMessageEntity,
  JobEntity,
  OrganizationEntity,
  ThreadEntity,
  ThreadGroupEntity,
  TranscriptMessageEntity,
} from '../persistence/entities';
import { writeSystemChunk } from '../persistence/system-chunk-writer';
import type { PlannedStep } from '../prompt-kit/messages/render-plan';
import { renderPlan } from '../prompt-kit/messages/render-plan';
import { LiveTurnStore } from '../surface/live-turn-store';
import { WebConventionEditProposalCard } from '../surface/web-convention-edit-proposal-card';
import { WebConventionProposalCard } from '../surface/web-convention-proposal-card';
import { nextFileRequestId, WebFileRequestCard } from '../surface/web-file-request-card';
import { WebMcpProposalCard } from '../surface/web-mcp-proposal-card';
import { nextQuestionId, WebQuestionCard } from '../surface/web-question-card';
import { WebSecretInputCard } from '../surface/web-secret-input-card';
import { WebSkillEditAccessCard } from '../surface/web-skill-edit-access-card';
import { WebSkillProposalCard } from '../surface/web-skill-proposal-card';
import { isDriverExecutableKind } from '../thread-kind/registry';
import { JobTitler } from '../titling/job-titler.service';
import type { TranscriptLine } from './brain.types';

export type CreateJobAutoMode = {
  approveMode?: Exclude<AutoApproveMode, 'both'>;
  merge?: boolean;
};

export interface ThreadRoute {
  channel: string | null;
  threadTs: string | null;
}

export interface PersistedPlan {
  thread: Job;
  decisionRecordId: string;
}

const ORDINAL_GAP = 10;

async function maxOrdinal<T extends ObjectLiteral>(
  repo: Repository<T>,
  jobId: string,
  extraWhere?: string,
): Promise<number> {
  const qb = repo
    .createQueryBuilder('t')
    .select('MAX(t.ordinal)', 'max')
    .where('t.job_id = :jobId', { jobId });
  if (extraWhere) qb.andWhere(extraWhere);
  const row = await qb.getRawOne<{ max: number | null }>();
  return row?.max ?? 0;
}

@Injectable()
export class BrainStoreService {
  private readonly logger = new Logger(BrainStoreService.name);

  constructor(
    @InjectRepository(JobEntity, DB_CONNECTION)
    private readonly jobs: Repository<JobEntity>,
    @InjectRepository(TranscriptMessageEntity, DB_CONNECTION)
    private readonly messages: Repository<TranscriptMessageEntity>,
    @InjectRepository(DecisionRecordEntity, DB_CONNECTION)
    private readonly records: Repository<DecisionRecordEntity>,
    @InjectRepository(ThreadEntity, DB_CONNECTION)
    private readonly threads: Repository<ThreadEntity>,
    @InjectRepository(ThreadGroupEntity, DB_CONNECTION)
    private readonly threadGroups: Repository<ThreadGroupEntity>,
    @InjectRepository(InboundMessageEntity, DB_CONNECTION)
    private readonly stimuli: Repository<InboundMessageEntity>,
    @InjectDataSource(DB_CONNECTION)
    private readonly dataSource: DataSource,
    private readonly titler: JobTitler,
    private readonly jobDeps: JobDependencyService,
    @InjectRepository(OrganizationEntity, DB_CONNECTION)
    private readonly organizations: Repository<OrganizationEntity>,
    @Optional() private readonly jobBootstrap?: JobBootstrapService,
    // Lets a pure-UI notice posted mid-turn (appendSystemNotice/Event/OperatorMessage below) register itself
    // on the live lane so it can be re-ordered to just after that turn's blocks once it flushes (see
    // `LiveTurnStore.registerPostTurnRow`). @Optional (trailing) for the same reason as `jobBootstrap`.
    @Optional() private readonly liveTurns?: LiveTurnStore,
  ) {}

  private async planningThreadId(jobId: string): Promise<string> {
    if (!this.jobBootstrap) throw new Error('brain-store: JobBootstrapService not wired');
    return this.jobBootstrap.planningThreadId(jobId);
  }

  /**
   * Best-effort: if a brain turn is currently streaming on this job's main lane, register `rowId` (a
   * pure-UI notice's just-saved row) on {@link LiveTurnStore} so its `order_at` gets stamped to just after
   * that turn's blocks once it flushes — instead of sorting by its own (earlier) post time. A no-op when no
   * turn is live, or when `liveTurns` wasn't wired (the @Optional direct-construction unit tests). Never
   * throws into the caller.
   */
  private async deferPostTurnRow(jobId: string, rowId: string): Promise<void> {
    if (!this.liveTurns) return;
    try {
      const job = await this.jobs.findOne({
        where: { id: jobId },
        select: { repo_id: true },
      });
      if (job) this.liveTurns.registerPostTurnRow(job.repo_id, jobId, rowId);
    } catch (err) {
      this.logger.debug(`deferPostTurnRow failed for job=${jobId} (ignored): ${err}`);
    }
  }

  /**
   * Resolve the thread an EVENT stimulus seeded (the intake seam opened it but the in-memory
   * an `EventMessage` doesn’t carry the delivery id). Reads the `stimuli` row's `job_id`. Null if the
   * stimulus isn't persisted (shouldn't happen — intake persists before consuming).
   */
  async eventThreadId(stimulusId: string): Promise<string | null> {
    const row = await this.stimuli.findOne({ where: { id: stimulusId } });
    return row?.job_id ?? null;
  }

  async ownerUserId(orgId: string): Promise<string | null> {
    const rows = await this.dataSource.query<{ user_id: string }[]>(
      `SELECT user_id FROM organization_members WHERE org_id = $1 AND role = 'owner' ORDER BY created_at ASC LIMIT 1`,
      [orgId],
    );
    return rows[0]?.user_id ?? null;
  }

  async transcript(jobId: string): Promise<TranscriptLine[]> {
    const rows = await this.messages
      .createQueryBuilder('m')
      .where('m.job_id = :jobId', { jobId })
      .orderBy('COALESCE(m.order_at, m.delivered_at, m.created_at)', 'ASC')
      .addOrderBy('m.created_at', 'ASC')
      .addOrderBy('m.id', 'ASC')
      .getMany();
    return rows.map((m) => ({
      author: m.author,
      isAtlas: m.author_bot_id != null,
      text: m.text,
    }));
  }

  async appendAtlasMessage(jobId: string, text: string): Promise<void> {
    await this.messages.save(
      this.messages.create({
        job_id: jobId,
        thread_id: await this.planningThreadId(jobId),
        author: 'Atlas',
        author_id: 'atlas',
        author_bot_id: 'atlas',
        text,
      }),
    );
  }

  async appendSystemOperatorMessage(
    jobId: string,
    text: string,
    extraMeta?: Record<string, unknown>,
  ): Promise<string> {
    const saved = await this.messages.save(
      this.messages.create({
        job_id: jobId,
        thread_id: await this.planningThreadId(jobId),
        author: 'System',
        author_id: 'system',
        author_bot_id: null,
        text,
        kind: 'chat',
        meta: { source: 'system_operator', ...extraMeta },
      }),
    );
    await this.deferPostTurnRow(jobId, saved.id);
    return saved.id;
  }

  /** Append a calm SYSTEM→OPERATOR notice (meta.source='system_notice'). Benign harness status the
   *  operator sees but Atlas never authored and never sees (its session is resumed separately). Unlike
   *  appendSystemOperatorMessage this carries NO error semantics (no halt, no Resume). */
  async appendSystemNotice(jobId: string, text: string): Promise<string> {
    const saved = await this.messages.save(
      this.messages.create({
        job_id: jobId,
        thread_id: await this.planningThreadId(jobId),
        author: 'System',
        author_id: 'system',
        author_bot_id: null,
        text,
        kind: 'chat',
        meta: { source: 'system_notice' },
      }),
    );
    await this.deferPostTurnRow(jobId, saved.id);
    return saved.id;
  }

  async hasRecentSystemOperatorNotice(
    jobId: string,
    text: string,
    withinMs = 120_000,
  ): Promise<boolean> {
    const since = new Date(Date.now() - withinMs);
    const existing = await this.messages.findOne({
      where: {
        job_id: jobId,
        author_id: 'system',
        text,
        created_at: MoreThan(since),
      },
    });
    return existing != null;
  }

  async appendBlock(
    jobId: string,
    block: {
      kind: string;
      text?: string;
      meta?: Record<string, unknown> | null;
      createdAt?: Date;
    },
  ): Promise<void> {
    await this.messages.save(
      this.messages.create({
        job_id: jobId,
        thread_id: await this.planningThreadId(jobId),
        author: 'Atlas',
        author_id: 'atlas',
        author_bot_id: 'atlas',
        text: block.text ?? '',
        kind: block.kind,
        meta: block.meta ?? null,
        ...(block.createdAt ? { created_at: block.createdAt } : {}),
      }),
    );
  }

  /**
   * Append a SYSTEM-EVENT line to a thread (kind='build_event') — a calm operator-visible pill, e.g.
   * "🔍 Codex is reviewing the plan…". Authored by Atlas so it renders on the agent side; the web renders
   * `build_event` rows as a tinted pill (tone derived from the text).
   */
  async appendSystemEvent(jobId: string, text: string): Promise<string> {
    const saved = await this.messages.save(
      this.messages.create({
        job_id: jobId,
        thread_id: await this.planningThreadId(jobId),
        author: 'Atlas',
        author_id: 'atlas',
        author_bot_id: 'atlas',
        text,
        kind: 'build_event',
      }),
    );
    await this.deferPostTurnRow(jobId, saved.id);
    return saved.id;
  }

  async appendCompactionSummary(jobId: string, text: string, summary: string): Promise<void> {
    await this.messages.save(
      this.messages.create({
        job_id: jobId,
        thread_id: await this.planningThreadId(jobId),
        author: 'Atlas',
        author_id: 'atlas',
        author_bot_id: 'atlas',
        text,
        kind: 'build_event',
        meta: { compactionSummary: summary },
      }),
    );
  }

  async recordSystemChunk(input: {
    jobId: string;
    kind: 'system_notice' | 'system_reminder' | 'untrusted';
    text: AgentMessage;
    chunkKey: string;
    reminderKind?: string;
    untrustedSource?: string;
    severity?: string;
    fullBody?: AgentMessage;
    framing?: string;
    createdAt?: Date;
    seedType?: string;
  }): Promise<void> {
    await writeSystemChunk(this.messages, {
      ...input,
      threadId: await this.planningThreadId(input.jobId),
    });
  }

  async latestBrainOccupancy(jobId: string): Promise<{
    contextTokens: number | null;
    contextLimit: number | null;
  } | null> {
    const rows: Array<{
      meta: {
        contextTokens?: number | null;
        contextLimit?: number | null;
      } | null;
    }> = await this.dataSource.query(
      `SELECT meta FROM transcript_messages
         WHERE job_id = $1 AND kind = 'turn_meta' AND meta->>'phaseId' IS NULL
         ORDER BY created_at DESC
         LIMIT 1`,
      [jobId],
    );
    const meta = rows[0]?.meta;
    if (!meta) return null;
    return {
      contextTokens: meta.contextTokens ?? null,
      contextLimit: meta.contextLimit ?? null,
    };
  }

  async appendCardMessage(
    jobId: string,
    input: { ts: string; text?: string; card: Record<string, unknown> },
  ): Promise<void> {
    await this.messages.save(
      this.messages.create({
        job_id: jobId,
        thread_id: await this.planningThreadId(jobId),
        author: 'Atlas',
        author_id: 'atlas',
        author_bot_id: 'atlas',
        text: input.text ?? '',
        kind: 'card',
        ts: input.ts,
        card: input.card,
      }),
    );
  }

  async appendClearedBlockCard(
    jobId: string,
    input: {
      threadId: string;
      gen: number;
      reason: string;
      evidence: string;
      text: string;
    },
  ): Promise<void> {
    const ts = `cleared:${input.threadId}:${input.gen}`;
    const dup = await this.messages.count({
      where: { job_id: jobId, ts, kind: 'card' },
    });
    if (dup > 0) return;
    await this.appendCardMessage(jobId, {
      ts,
      text: input.text,
      card: {
        type: 'cleared_block_card',
        threadId: input.threadId,
        reason: input.reason,
        evidence: input.evidence,
      },
    });
  }

  async listClearedBlockCards(
    jobId: string,
  ): Promise<{ threadId: string; reason: string; evidence: string; at: Date }[]> {
    const rows = await this.messages.find({
      where: { job_id: jobId, kind: 'card' },
      order: { created_at: 'ASC' },
    });
    return rows
      .filter((m) => m.card?.type === 'cleared_block_card')
      .map((m) => {
        const c = m.card ?? {};
        return {
          threadId: String(c['threadId'] ?? ''),
          reason: String(c['reason'] ?? ''),
          evidence: String(c['evidence'] ?? ''),
          at: m.created_at,
        };
      });
  }

  async updateCardMessage(
    jobId: string,
    ts: string,
    patch: Record<string, unknown>,
  ): Promise<void> {
    const row = await this.messages.findOne({
      where: { job_id: jobId, ts, kind: 'card' },
    });
    if (!row) return;
    row.card = { ...(row.card ?? {}), ...patch };
    await this.messages.save(row);
  }

  private async questionCards(jobId: string): Promise<TranscriptMessageEntity[]> {
    const rows = await this.messages.find({
      where: { job_id: jobId, kind: 'card' },
      order: { created_at: 'DESC' },
    });
    return rows.filter((m) => m.card?.type === 'question_card');
  }

  async nextQuestionId(jobId: string): Promise<string> {
    const cards = await this.questionCards(jobId);
    return nextQuestionId(cards.map((m) => m.ts ?? ''));
  }

  async latestAnsweredQuestionCard(jobId: string): Promise<TranscriptMessageEntity | null> {
    const cards = await this.questionCards(jobId);
    const answered = cards.filter((m) => {
      const c = m.card as Record<string, unknown>;
      return c.answer != null && c.loggedDecision !== true;
    });
    answered.sort((a, b) => {
      const aAt = String((a.card as Record<string, unknown>).answeredAt ?? '');
      const bAt = String((b.card as Record<string, unknown>).answeredAt ?? '');
      return bAt.localeCompare(aAt); // newest answeredAt first (ISO strings sort lexically)
    });
    return answered[0] ?? null;
  }

  async openQuestion(
    jobId: string,
    input: { ts: string; text?: string; card: Record<string, unknown> },
  ): Promise<{ ok: boolean }> {
    return this.dataSource.transaction(async (m) => {
      const threads = m.getRepository(JobEntity);
      const messages = m.getRepository(TranscriptMessageEntity);
      const thread = await threads.findOne({ where: { id: jobId } });
      if (!thread) return { ok: false };
      await messages.save(
        messages.create({
          job_id: jobId,
          thread_id: await this.planningThreadId(jobId),
          author: 'Atlas',
          author_id: 'atlas',
          author_bot_id: 'atlas',
          text: input.text ?? '',
          kind: 'card',
          ts: input.ts,
          card: input.card,
        }),
      );
      await threads
        .createQueryBuilder()
        .update()
        .set({ open_question_count: () => 'open_question_count + 1' })
        .where('id = :jobId', { jobId })
        .execute();
      return { ok: true };
    });
  }

  async markQuestionAnswered(
    jobId: string,
    questionId: string,
    answer: string,
  ): Promise<{ firstAnswer: boolean }> {
    return this.dataSource.transaction(async (m) => {
      const patch = JSON.stringify({
        answer,
        answeredAt: new Date().toISOString(),
      });
      const res = await m
        .createQueryBuilder()
        .update(TranscriptMessageEntity)
        .set({ card: () => 'card || :patch::jsonb' })
        .where('job_id = :jobId', { jobId })
        .andWhere('ts = :questionId', { questionId })
        .andWhere("kind = 'card'")
        .andWhere("card ->> 'type' = 'question_card'")
        .andWhere("card ->> 'answer' IS NULL")
        .andWhere("card ->> 'deliveredAt' IS NULL")
        .andWhere("card ->> 'withdrawnAt' IS NULL")
        .setParameter('patch', patch)
        .execute();
      const firstAnswer = (res.affected ?? 0) === 1;
      if (firstAnswer) {
        await m
          .createQueryBuilder()
          .update(JobEntity)
          .set({
            open_question_count: () => 'GREATEST(0, open_question_count - 1)',
          })
          .where('id = :jobId', { jobId })
          .execute();
      }
      return { firstAnswer };
    });
  }

  async openQuestionCards(jobId: string): Promise<WebQuestionCard[]> {
    const cards = await this.questionCards(jobId);
    return cards
      .map((m) => m.card as unknown as WebQuestionCard)
      .filter((c) => c.answer == null && c.withdrawnAt == null && c.origin !== 'build');
  }

  async withdrawQuestion(
    jobId: string,
    questionId: string,
    reason?: string,
  ): Promise<{ withdrawn: boolean }> {
    return this.dataSource.transaction(async (m) => {
      const patch = JSON.stringify({
        withdrawnAt: new Date().toISOString(),
        ...(reason ? { withdrawnReason: reason } : {}),
      });
      const res = await m
        .createQueryBuilder()
        .update(TranscriptMessageEntity)
        .set({ card: () => 'card || :patch::jsonb' })
        .where('job_id = :jobId', { jobId })
        .andWhere('ts = :questionId', { questionId })
        .andWhere("kind = 'card'")
        .andWhere("card ->> 'type' = 'question_card'")
        .andWhere("card ->> 'answer' IS NULL")
        .andWhere("card ->> 'withdrawnAt' IS NULL")
        .setParameter('patch', patch)
        .execute();
      const withdrawn = (res.affected ?? 0) === 1;
      if (withdrawn) {
        await m
          .createQueryBuilder()
          .update(JobEntity)
          .set({
            open_question_count: () => 'GREATEST(0, open_question_count - 1)',
          })
          .where('id = :jobId', { jobId })
          .execute();
      }
      return { withdrawn };
    });
  }

  async getQuestionCard(jobId: string, questionId: string): Promise<WebQuestionCard | null> {
    const row = await this.messages.findOne({
      where: { job_id: jobId, ts: questionId, kind: 'card' },
    });
    const card = row?.card as WebQuestionCard | undefined;
    return card?.type === 'question_card' ? card : null;
  }

  async markQuestionDelivered(jobId: string, questionId: string): Promise<void> {
    await this.updateCardMessage(jobId, questionId, {
      deliveredAt: new Date().toISOString(),
    });
  }

  async findUndeliveredAnsweredQuestions(): Promise<
    {
      jobId: string;
      orgId: string;
      repoId: string;
      questionId: string;
      question: string;
      answer: string;
    }[]
  > {
    const raw = await this.messages
      .createQueryBuilder('m')
      .innerJoin(JobEntity, 't', 't.id = m.job_id')
      .where("m.kind = 'card'")
      .andWhere("m.card ->> 'type' = 'question_card'")
      .andWhere("m.card ->> 'answer' IS NOT NULL")
      .andWhere("m.card ->> 'deliveredAt' IS NULL")
      .select('m.job_id', 'jobId')
      .addSelect('m.ts', 'questionId')
      .addSelect("m.card ->> 'question'", 'question')
      .addSelect("m.card ->> 'answer'", 'answer')
      .addSelect('t.org_id', 'orgId')
      .addSelect('t.repo_id', 'repoId')
      .orderBy("m.card ->> 'answeredAt'", 'ASC')
      .getRawMany<{
        jobId: string;
        orgId: string;
        repoId: string;
        questionId: string;
        question: string | null;
        answer: string | null;
      }>();
    return raw.map((r) => ({
      jobId: r.jobId,
      orgId: r.orgId,
      repoId: r.repoId,
      questionId: r.questionId,
      question: r.question ?? '',
      answer: r.answer ?? '',
    }));
  }

  async reconcileOpenQuestionCounts(): Promise<void> {
    const messagesTable = this.messages.metadata.tablePath;
    const threadsTable = this.jobs.metadata.tablePath;
    await this.dataSource.query(
      `UPDATE ${threadsTable} t SET open_question_count = (
         SELECT COUNT(*)::int FROM ${messagesTable} m
         WHERE m.job_id = t.id AND m.kind = 'card'
           AND m.card ->> 'type' = 'question_card'
           AND m.card ->> 'answer' IS NULL
           AND m.card ->> 'withdrawnAt' IS NULL
       )`,
    );
  }

  async openSecretRequest(
    jobId: string,
    input: { requestId: string; card: WebSecretInputCard },
  ): Promise<{ ok: boolean; alreadyOpen?: boolean }> {
    const text = input.card.ephemeral
      ? `Requested a one-time value \`${input.card.name}\` (delivered to the running session, not stored)`
      : input.card.mcp
        ? `Requested secret \`${input.card.mcp.key}\` for MCP server \`${input.card.mcp.server}\``
        : `Requested secret \`${input.card.name}\` → \`${input.card.path}\``;
    return this.dataSource.transaction(async (m) => {
      const threads = m.getRepository(JobEntity);
      const messages = m.getRepository(TranscriptMessageEntity);
      const thread = await threads.findOne({ where: { id: jobId } });
      if (!thread) return { ok: false };
      if (input.card.ephemeral && thread.awaiting_secret_id) {
        const open = await messages.findOne({
          where: {
            job_id: jobId,
            ts: thread.awaiting_secret_id,
            kind: 'card',
          },
        });
        const card = open?.card as WebSecretInputCard | undefined;
        if (card && card.provided_at == null) return { ok: false, alreadyOpen: true };
      }
      await messages.save(
        messages.create({
          job_id: jobId,
          thread_id: await this.planningThreadId(jobId),
          author: 'Atlas',
          author_id: 'atlas',
          author_bot_id: 'atlas',
          text,
          kind: 'card',
          ts: input.requestId,
          card: input.card as unknown as Record<string, unknown>,
        }),
      );
      if (input.card.ephemeral) {
        await threads.update({ id: jobId }, { awaiting_secret_id: input.requestId });
      } else {
        await threads
          .createQueryBuilder()
          .update()
          .set({ open_secret_count: () => 'open_secret_count + 1' })
          .where('id = :jobId', { jobId })
          .execute();
      }
      return { ok: true };
    });
  }

  async awaitingSecretId(jobId: string): Promise<string | null> {
    const row = await this.jobs.findOne({ where: { id: jobId } });
    return row?.awaiting_secret_id ?? null;
  }

  async getSecretCard(jobId: string, requestId: string): Promise<WebSecretInputCard | null> {
    const row = await this.messages.findOne({
      where: { job_id: jobId, ts: requestId, kind: 'card' },
    });
    const card = row?.card as WebSecretInputCard | undefined;
    return card?.type === 'secret_input_card' ? card : null;
  }

  async markSecretProvided(jobId: string, requestId: string): Promise<void> {
    await this.updateCardMessage(jobId, requestId, {
      provided_at: new Date().toISOString(),
    });
  }

  async markSecretDelivered(jobId: string, requestId: string): Promise<void> {
    await this.updateCardMessage(jobId, requestId, {
      delivered_at: new Date().toISOString(),
    });
  }

  async clearAwaitingSecret(jobId: string, requestId: string): Promise<void> {
    await this.jobs.update(
      { id: jobId, awaiting_secret_id: requestId },
      { awaiting_secret_id: null },
    );
  }

  async markSecretProvidedPerCard(jobId: string, requestId: string): Promise<void> {
    await this.dataSource.transaction(async (m) => {
      const patch = JSON.stringify({ provided_at: new Date().toISOString() });
      const res = await m
        .createQueryBuilder()
        .update(TranscriptMessageEntity)
        .set({ card: () => 'card || :patch::jsonb' })
        .where('job_id = :jobId', { jobId })
        .andWhere('ts = :requestId', { requestId })
        .andWhere("kind = 'card'")
        .andWhere("card ->> 'type' = 'secret_input_card'")
        .andWhere("card ->> 'provided_at' IS NULL")
        .andWhere("card ->> 'withdrawnAt' IS NULL")
        .andWhere("card ->> 'ephemeral' IS DISTINCT FROM 'true'")
        .setParameter('patch', patch)
        .execute();
      if ((res.affected ?? 0) === 1) {
        await m
          .createQueryBuilder()
          .update(JobEntity)
          .set({
            open_secret_count: () => 'GREATEST(0, open_secret_count - 1)',
          })
          .where('id = :jobId', { jobId })
          .execute();
      }
    });
  }

  async openSecretCards(jobId: string): Promise<WebSecretInputCard[]> {
    const rows = await this.messages.find({
      where: { job_id: jobId, kind: 'card' },
      order: { created_at: 'DESC' },
    });
    return rows
      .map((m) => m.card as unknown as WebSecretInputCard)
      .filter(
        (c) =>
          c?.type === 'secret_input_card' &&
          c.provided_at == null &&
          c.withdrawnAt == null &&
          c.ephemeral !== true,
      );
  }

  async withdrawSecretRequest(
    jobId: string,
    requestId: string,
    reason?: string,
  ): Promise<{ withdrawn: boolean }> {
    return this.dataSource.transaction(async (m) => {
      const patch = JSON.stringify({
        withdrawnAt: new Date().toISOString(),
        ...(reason ? { withdrawnReason: reason } : {}),
      });
      const res = await m
        .createQueryBuilder()
        .update(TranscriptMessageEntity)
        .set({ card: () => 'card || :patch::jsonb' })
        .where('job_id = :jobId', { jobId })
        .andWhere('ts = :requestId', { requestId })
        .andWhere("kind = 'card'")
        .andWhere("card ->> 'type' = 'secret_input_card'")
        .andWhere("card ->> 'provided_at' IS NULL")
        .andWhere("card ->> 'withdrawnAt' IS NULL")
        .andWhere("card ->> 'ephemeral' IS DISTINCT FROM 'true'")
        .setParameter('patch', patch)
        .execute();
      const withdrawn = (res.affected ?? 0) === 1;
      if (withdrawn) {
        await m
          .createQueryBuilder()
          .update(JobEntity)
          .set({
            open_secret_count: () => 'GREATEST(0, open_secret_count - 1)',
          })
          .where('id = :jobId', { jobId })
          .execute();
      }
      return { withdrawn };
    });
  }

  async findUndeliveredProvidedSecrets(): Promise<
    {
      jobId: string;
      orgId: string;
      repoId: string;
      requestId: string;
      name: string;
      path?: string;
      ephemeral?: boolean;
      mcp?: { server: string; slot: 'header' | 'env'; key: string };
    }[]
  > {
    type Row = {
      jobId: string;
      orgId: string;
      repoId: string;
      requestId: string;
      name: string;
      path?: string;
      ephemeral?: boolean;
      mcp?: { server: string; slot: 'header' | 'env'; key: string };
    };
    const out: Row[] = [];
    const pointed = await this.jobs.find({
      where: { awaiting_secret_id: Not(IsNull()) },
    });
    for (const t of pointed) {
      const card = await this.getSecretCard(t.id, t.awaiting_secret_id!);
      if (card?.ephemeral === true && card.provided_at != null && card.delivered_at == null) {
        out.push({
          jobId: t.id,
          orgId: t.org_id,
          repoId: t.repo_id,
          requestId: t.awaiting_secret_id!,
          name: card.name,
          ...(card.path ? { path: card.path } : {}),
          ephemeral: true,
          ...(card.mcp ? { mcp: card.mcp } : {}),
        });
      }
    }
    const messagesTable = this.messages.metadata.tablePath;
    const threadsTable = this.jobs.metadata.tablePath;
    const rows: {
      jobId: string;
      orgId: string;
      repoId: string;
      requestId: string;
      card: WebSecretInputCard;
    }[] = await this.dataSource.query(
      `SELECT m.job_id AS "jobId", t.org_id AS "orgId", t.repo_id AS "repoId",
              m.ts AS "requestId", m.card AS "card"
         FROM ${messagesTable} m
         JOIN ${threadsTable} t ON t.id = m.job_id
        WHERE m.kind = 'card'
          AND m.card ->> 'type' = 'secret_input_card'
          AND m.card ->> 'provided_at' IS NOT NULL
          AND m.card ->> 'delivered_at' IS NULL
          AND m.card ->> 'withdrawnAt' IS NULL
          AND m.card ->> 'ephemeral' IS DISTINCT FROM 'true'`,
    );
    for (const r of rows) {
      out.push({
        jobId: r.jobId,
        orgId: r.orgId,
        repoId: r.repoId,
        requestId: r.requestId,
        name: r.card.name,
        ...(r.card.path ? { path: r.card.path } : {}),
        ...(r.card.mcp ? { mcp: r.card.mcp } : {}),
      });
    }
    return out;
  }

  async reconcileOpenSecretCounts(): Promise<void> {
    const messagesTable = this.messages.metadata.tablePath;
    const threadsTable = this.jobs.metadata.tablePath;
    await this.dataSource.query(
      `UPDATE ${threadsTable} t SET open_secret_count = (
         SELECT COUNT(*)::int FROM ${messagesTable} m
         WHERE m.job_id = t.id AND m.kind = 'card'
           AND m.card ->> 'type' = 'secret_input_card'
           AND m.card ->> 'provided_at' IS NULL
           AND m.card ->> 'withdrawnAt' IS NULL
           AND m.card ->> 'ephemeral' IS DISTINCT FROM 'true'
       )`,
    );
  }

  private async fileRequestCards(jobId: string): Promise<TranscriptMessageEntity[]> {
    const rows = await this.messages.find({
      where: { job_id: jobId, kind: 'card' },
      order: { created_at: 'DESC' },
    });
    return rows.filter((m) => m.card?.type === 'file_request_card');
  }

  async nextFileRequestId(jobId: string): Promise<string> {
    const cards = await this.fileRequestCards(jobId);
    return nextFileRequestId(cards.map((m) => m.ts ?? ''));
  }

  async openFileRequest(
    jobId: string,
    input: { requestId: string; card: WebFileRequestCard },
  ): Promise<{ ok: boolean }> {
    const thread = await this.jobs.findOne({ where: { id: jobId } });
    if (!thread) return { ok: false };
    await this.messages.save(
      this.messages.create({
        job_id: jobId,
        thread_id: await this.planningThreadId(jobId),
        author: 'Atlas',
        author_id: 'atlas',
        author_bot_id: 'atlas',
        text: `Requested file upload → \`${input.card.path}\``,
        kind: 'card',
        ts: input.requestId,
        card: input.card as unknown as Record<string, unknown>,
      }),
    );
    return { ok: true };
  }

  async getFileCard(jobId: string, requestId: string): Promise<WebFileRequestCard | null> {
    const row = await this.messages.findOne({
      where: { job_id: jobId, ts: requestId, kind: 'card' },
    });
    const card = row?.card as WebFileRequestCard | undefined;
    return card?.type === 'file_request_card' ? card : null;
  }

  async markFileProvided(jobId: string, requestId: string, filename: string): Promise<void> {
    await this.updateCardMessage(jobId, requestId, {
      provided_at: new Date().toISOString(),
      filename,
    });
  }

  async markFileDelivered(jobId: string, requestId: string): Promise<void> {
    await this.updateCardMessage(jobId, requestId, {
      delivered_at: new Date().toISOString(),
    });
  }

  async openFileCards(jobId: string): Promise<WebFileRequestCard[]> {
    const rows = await this.messages.find({
      where: { job_id: jobId, kind: 'card' },
      order: { created_at: 'DESC' },
    });
    return rows
      .map((m) => m.card as unknown as WebFileRequestCard)
      .filter(
        (c) => c?.type === 'file_request_card' && c.provided_at == null && c.withdrawnAt == null,
      );
  }

  async withdrawFileRequest(
    jobId: string,
    requestId: string,
    reason?: string,
  ): Promise<{ withdrawn: boolean }> {
    const patch = JSON.stringify({
      withdrawnAt: new Date().toISOString(),
      ...(reason ? { withdrawnReason: reason } : {}),
    });
    const res = await this.messages
      .createQueryBuilder()
      .update(TranscriptMessageEntity)
      .set({ card: () => 'card || :patch::jsonb' })
      .where('job_id = :jobId', { jobId })
      .andWhere('ts = :requestId', { requestId })
      .andWhere("kind = 'card'")
      .andWhere("card ->> 'type' = 'file_request_card'")
      .andWhere("card ->> 'provided_at' IS NULL")
      .andWhere("card ->> 'withdrawnAt' IS NULL")
      .setParameter('patch', patch)
      .execute();
    return { withdrawn: (res.affected ?? 0) === 1 };
  }

  async findUndeliveredProvidedFiles(): Promise<
    {
      jobId: string;
      orgId: string;
      repoId: string;
      requestId: string;
      path: string;
    }[]
  > {
    const messagesTable = this.messages.metadata.tablePath;
    const threadsTable = this.jobs.metadata.tablePath;
    const rows = await this.dataSource.query(
      `SELECT m.job_id AS "jobId", t.org_id AS "orgId", t.repo_id AS "repoId",
              m.ts AS "requestId", m.card ->> 'path' AS "path"
         FROM ${messagesTable} m
         JOIN ${threadsTable} t ON t.id = m.job_id
        WHERE m.kind = 'card'
          AND m.card ->> 'type' = 'file_request_card'
          AND m.card ->> 'provided_at' IS NOT NULL
          AND m.card ->> 'delivered_at' IS NULL`,
    );
    return rows;
  }

  async openMcpProposal(
    jobId: string,
    input: { requestId: string; card: WebMcpProposalCard },
  ): Promise<{ ok: boolean }> {
    const thread = await this.jobs.findOne({ where: { id: jobId } });
    if (!thread) return { ok: false };
    const text =
      input.card.mode === 'remove'
        ? `Proposed removing MCP server(s): ${(input.card.removeNames ?? [])
            .map((n) => `\`${n}\``)
            .join(', ')}`
        : `Proposed ${input.card.servers.length} MCP server(s): ${input.card.servers
            .map((s) => `\`${s.name}\``)
            .join(', ')}`;
    await this.messages.save(
      this.messages.create({
        job_id: jobId,
        thread_id: await this.planningThreadId(jobId),
        author: 'Atlas',
        author_id: 'atlas',
        author_bot_id: 'atlas',
        text,
        kind: 'card',
        ts: input.requestId,
        card: input.card as unknown as Record<string, unknown>,
      }),
    );
    return { ok: true };
  }

  async getMcpProposalCard(jobId: string, requestId: string): Promise<WebMcpProposalCard | null> {
    const row = await this.messages.findOne({
      where: { job_id: jobId, ts: requestId, kind: 'card' },
    });
    const card = row?.card as WebMcpProposalCard | undefined;
    return card?.type === 'mcp_proposal_card' ? card : null;
  }

  async markMcpProposalApproved(
    jobId: string,
    requestId: string,
    committed: string[],
  ): Promise<void> {
    await this.updateCardMessage(jobId, requestId, {
      approved_at: new Date().toISOString(),
      committed,
    });
  }

  async openConventionProposal(
    jobId: string,
    input: { requestId: string; card: WebConventionProposalCard },
  ): Promise<{ ok: boolean }> {
    const thread = await this.jobs.findOne({ where: { id: jobId } });
    if (!thread) return { ok: false };
    await this.messages.save(
      this.messages.create({
        job_id: jobId,
        thread_id: await this.planningThreadId(jobId),
        author: 'Atlas',
        author_id: 'atlas',
        author_bot_id: 'atlas',
        text: `Proposed the "${input.card.profileName}" house-style profile for this repo`,
        kind: 'card',
        ts: input.requestId,
        card: input.card as unknown as Record<string, unknown>,
      }),
    );
    return { ok: true };
  }

  async getConventionProposalCard(
    jobId: string,
    requestId: string,
  ): Promise<WebConventionProposalCard | null> {
    const row = await this.messages.findOne({
      where: { job_id: jobId, ts: requestId, kind: 'card' },
    });
    const card = row?.card as WebConventionProposalCard | undefined;
    return card?.type === 'convention_proposal_card' ? card : null;
  }

  async markConventionProposalApproved(jobId: string, requestId: string): Promise<void> {
    await this.updateCardMessage(jobId, requestId, {
      approved_at: new Date().toISOString(),
    });
  }

  async openConventionEditProposal(
    jobId: string,
    input: { requestId: string; card: WebConventionEditProposalCard },
  ): Promise<{ ok: boolean }> {
    const thread = await this.jobs.findOne({ where: { id: jobId } });
    if (!thread) return { ok: false };
    const verb = input.card.mode === 'create' ? 'Proposed a new' : 'Proposed changes to the';
    await this.messages.save(
      this.messages.create({
        job_id: jobId,
        thread_id: await this.planningThreadId(jobId),
        author: 'Atlas',
        author_id: 'atlas',
        author_bot_id: 'atlas',
        text: `${verb} "${input.card.name}" house-style profile`,
        kind: 'card',
        ts: input.requestId,
        card: input.card as unknown as Record<string, unknown>,
      }),
    );
    return { ok: true };
  }

  async getConventionEditProposalCard(
    jobId: string,
    requestId: string,
  ): Promise<WebConventionEditProposalCard | null> {
    const row = await this.messages.findOne({
      where: { job_id: jobId, ts: requestId, kind: 'card' },
    });
    const card = row?.card as WebConventionEditProposalCard | undefined;
    return card?.type === 'convention_edit_proposal_card' ? card : null;
  }

  async markConventionEditProposalApproved(jobId: string, requestId: string): Promise<void> {
    await this.updateCardMessage(jobId, requestId, {
      approved_at: new Date().toISOString(),
    });
  }

  async openSkillProposal(
    jobId: string,
    input: { requestId: string; card: WebSkillProposalCard },
  ): Promise<{ ok: boolean }> {
    const thread = await this.jobs.findOne({ where: { id: jobId } });
    if (!thread) return { ok: false };
    const verb =
      input.card.mode === 'create'
        ? 'Proposed a new'
        : input.card.mode === 'remove'
          ? 'Proposed removing the'
          : 'Proposed changes to the';
    await this.messages.save(
      this.messages.create({
        job_id: jobId,
        thread_id: await this.planningThreadId(jobId),
        author: 'Atlas',
        author_id: 'atlas',
        author_bot_id: 'atlas',
        text: `${verb} "${input.card.name}" skill`,
        kind: 'card',
        ts: input.requestId,
        card: input.card as unknown as Record<string, unknown>,
      }),
    );
    return { ok: true };
  }

  async getSkillProposalCard(
    jobId: string,
    requestId: string,
  ): Promise<WebSkillProposalCard | null> {
    const row = await this.messages.findOne({
      where: { job_id: jobId, ts: requestId, kind: 'card' },
    });
    const card = row?.card as WebSkillProposalCard | undefined;
    return card?.type === 'skill_proposal_card' ? card : null;
  }

  async markSkillProposalApproved(jobId: string, requestId: string): Promise<void> {
    await this.updateCardMessage(jobId, requestId, {
      approved_at: new Date().toISOString(),
    });
  }

  async openSkillEditAccessRequest(
    jobId: string,
    input: { requestId: string; card: WebSkillEditAccessCard },
  ): Promise<{ ok: boolean }> {
    const thread = await this.jobs.findOne({ where: { id: jobId } });
    if (!thread) return { ok: false };
    await this.messages.save(
      this.messages.create({
        job_id: jobId,
        thread_id: await this.planningThreadId(jobId),
        author: 'Atlas',
        author_id: 'atlas',
        author_bot_id: 'atlas',
        text: `Requested edit access to the "${input.card.name}" skill`,
        kind: 'card',
        ts: input.requestId,
        card: input.card as unknown as Record<string, unknown>,
      }),
    );
    return { ok: true };
  }

  async getSkillEditAccessCard(
    jobId: string,
    requestId: string,
  ): Promise<WebSkillEditAccessCard | null> {
    const row = await this.messages.findOne({
      where: { job_id: jobId, ts: requestId, kind: 'card' },
    });
    const card = row?.card as WebSkillEditAccessCard | undefined;
    return card?.type === 'skill_edit_access_card' ? card : null;
  }

  async markSkillEditAccessApproved(
    jobId: string,
    requestId: string,
    forkedTo?: string,
  ): Promise<void> {
    await this.updateCardMessage(jobId, requestId, {
      approved_at: new Date().toISOString(),
      ...(forkedTo ? { forkedTo } : {}),
    });
  }

  async pendingDecisions(jobId: string): Promise<Decision[]> {
    const row = await this.jobs.findOne({ where: { id: jobId } });
    return row?.pending_decisions ?? [];
  }

  async createDecision(
    jobId: string,
    input: Omit<Decision, 'id'>,
  ): Promise<{ decision: Decision; all: Decision[] }> {
    const row = await this.jobs.findOneOrFail({ where: { id: jobId } });
    const current = row.pending_decisions ?? [];
    const decision: Decision = { ...input, id: nextDecisionId(current) };
    const all = [...current, decision];
    await this.jobs.update({ id: jobId }, { pending_decisions: all });
    return { decision, all };
  }

  async updateDecision(
    jobId: string,
    id: string,
    patch: Partial<Pick<Decision, 'ruling' | 'title' | 'decisionClass' | 'confirmedByOperator'>>,
  ): Promise<{ decision: Decision; all: Decision[] } | null> {
    const row = await this.jobs.findOneOrFail({ where: { id: jobId } });
    const current = row.pending_decisions ?? [];
    const idx = current.findIndex((d) => d.id === id);
    if (idx < 0) return null;
    const decision: Decision = { ...current[idx], ...patch };
    const all = current.map((d, i) => (i === idx ? decision : d));
    await this.jobs.update({ id: jobId }, { pending_decisions: all });
    return { decision, all };
  }

  async deleteDecision(jobId: string, id: string): Promise<{ removed: boolean; all: Decision[] }> {
    const row = await this.jobs.findOneOrFail({ where: { id: jobId } });
    const current = row.pending_decisions ?? [];
    const all = current.filter((d) => d.id !== id);
    if (all.length === current.length) return { removed: false, all };
    await this.jobs.update({ id: jobId }, { pending_decisions: all });
    return { removed: true, all };
  }

  async setActivity(jobId: string, activity: JobActivity): Promise<void> {
    await this.jobs.update({ id: jobId }, { activity });
  }

  async endTurnActivity(jobId: string): Promise<void> {
    const reviewing = await this.threads
      .createQueryBuilder('t')
      .where('t.job_id = :jobId', { jobId })
      .andWhere("t.role = 'plan_review'")
      .andWhere("t.config ->> 'status' = 'running'")
      .getExists();
    const job = reviewing
      ? null
      : await this.jobs.findOne({
          where: { id: jobId },
          select: { id: true, session_resume: true },
        });
    const retrying = job?.session_resume?.kind === 'retry';
    await this.jobs.update(
      { id: jobId },
      { activity: reviewing ? 'plan_review' : retrying ? 'retrying' : 'idle' },
    );
  }

  async setHalted(jobId: string, halted: boolean): Promise<void> {
    await this.jobs.update(
      { id: jobId },
      halted ? { halted: true, activity: 'idle' } : { halted: false },
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

  async claimBenignAbortRedrive(
    jobId: string,
    cap: number,
  ): Promise<{ ok: boolean; used: number }> {
    const res = await this.jobs
      .createQueryBuilder()
      .update(JobEntity)
      .set({
        benign_abort_redrives: () => 'benign_abort_redrives + 1',
        retry_last_attempt_at: () => 'now()',
      })
      .where('id = :jobId', { jobId })
      .andWhere('benign_abort_redrives < :cap', { cap })
      .returning('benign_abort_redrives')
      .execute();
    const used = res.raw?.[0]?.benign_abort_redrives as number | undefined;
    return used != null ? { ok: true, used } : { ok: false, used: cap };
  }

  async claimTransientRetryRedrive(
    jobId: string,
    cap: number,
  ): Promise<{ ok: boolean; used: number }> {
    const res = await this.jobs
      .createQueryBuilder()
      .update(JobEntity)
      .set({
        transient_retry_redrives: () => 'transient_retry_redrives + 1',
        retry_last_attempt_at: () => 'now()',
      })
      .where('id = :jobId', { jobId })
      .andWhere('transient_retry_redrives < :cap', { cap })
      .returning('transient_retry_redrives')
      .execute();
    const used = res.raw?.[0]?.transient_retry_redrives as number | undefined;
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

  async clearBrainRetryCounters(jobId: string): Promise<void> {
    await this.jobs.update(
      { id: jobId },
      {
        benign_abort_redrives: 0,
        transient_retry_redrives: 0,
        session_limit_text_misfires: 0,
      },
    );
  }

  async recordDirectBuildVerification(
    jobId: string,
    payload: JobEntity['direct_build_verification'],
  ): Promise<void> {
    await this.jobs.update({ id: jobId }, { direct_build_verification: payload });
  }

  async markDirectBuildStarted(jobId: string): Promise<void> {
    await this.jobs.update({ id: jobId }, { direct_build_started_at: new Date() });
  }

  async threadsWithActiveTurn(): Promise<string[]> {
    const rows = await this.jobs.find({
      where: { activity: 'turn' },
      select: { id: true },
    });
    return rows.map((r) => r.id);
  }

  async resetAllActivity(): Promise<number> {
    const res = await this.jobs.update({ activity: Not('idle') }, { activity: 'idle' });
    return res.affected ?? 0;
  }

  async route(thread: { orgId: string; repoId: string; jobId: string }): Promise<ThreadRoute> {
    return { channel: thread.repoId, threadTs: thread.jobId };
  }

  async openJobOnThread(jobId: string): Promise<string | null> {
    const row = await this.jobs.findOne({
      where: { id: jobId, status: In(['planning', 'amending']) },
    });
    return row?.id ?? null;
  }

  async jobKind(jobId: string): Promise<JobKind | null> {
    const row = await this.jobs.findOne({
      where: { id: jobId },
      select: { id: true, kind: true },
    });
    return (row?.kind as JobKind | null | undefined) ?? null;
  }

  async jobTitle(jobId: string): Promise<string | null> {
    const row = await this.jobs.findOne({
      where: { id: jobId },
      select: { id: true, title: true },
    });
    return row?.title ?? null;
  }

  async setJobKind(jobId: string, kind: JobKind): Promise<void> {
    await this.jobs.update({ id: jobId }, { kind });
  }

  async openJob(input: {
    orgId: string;
    repoId: string;
    jobId: string;
    title?: string | null;
    kind: JobKind;
  }): Promise<string> {
    const title = input.title?.trim();
    await this.jobs.update(
      { id: input.jobId },
      { kind: input.kind, status: 'planning', ...(title ? { title } : {}) },
    );
    return input.jobId;
  }

  async persistPlan(input: {
    orgId: string;
    repoId: string;
    jobId: string;
    title: string;
    kind: JobKind;
    overview: string;
    decisions: Decision[];
    threadTitles: string[];
    threadTypes?: string[];
    stepsByThread?: PlannedStep[][];
    status?: JobStatus;
    rename?: boolean;
  }): Promise<PersistedPlan> {
    const existingTitle = (await this.jobTitle(input.jobId))?.trim() || null;
    const title =
      (input.rename ?? true) || !existingTitle
        ? await this.titler.titleFor(input.title, input.orgId)
        : existingTitle;

    await this.ensurePlanningThreadGroup(input.jobId, input.orgId);

    const decisionRecordId = await this.dataSource.transaction(async (m) => {
      const jobs = m.getRepository(JobEntity);
      const records = m.getRepository(DecisionRecordEntity);
      const threads = m.getRepository(ThreadEntity);
      const threadGroups = m.getRepository(ThreadGroupEntity);

      const currentJob = await jobs.findOne({ where: { id: input.jobId } });
      const priorRecordId = currentJob?.decision_record_id ?? null;
      const priorHasDone = priorRecordId
        ? await threads
            .createQueryBuilder('t')
            .innerJoin(ThreadGroupEntity, 's', 's.id = t.thread_group_id')
            .where('t.job_id = :jobId', { jobId: input.jobId })
            .andWhere('s.decision_record_id = :priorRecordId', {
              priorRecordId,
            })
            .andWhere("t.role = 'builder'")
            .andWhere("t.status = 'done'")
            .getExists()
        : false;

      if (!priorHasDone) {
        await threadGroups.delete({
          job_id: input.jobId,
          kind: In(['build', 'direct_build', 'master_review']),
        });
      }

      await records.update({ job_id: input.jobId, status: 'draft' }, { status: 'superseded' });

      const record = await records.save(
        records.create({
          org_id: input.orgId,
          repo_id: input.repoId,
          job_id: input.jobId,
          status: 'draft',
          overview: input.overview,
          decisions: input.decisions,
          thread_titles: input.threadTitles,
          approved_by: null,
          approved_at: null,
        }),
      );

      if (input.threadTitles.length > 0) {
        let threadGroupOrdinal = (await maxOrdinal(threadGroups, input.jobId)) + ORDINAL_GAP;
        let threadOrdinal =
          (await maxOrdinal(threads, input.jobId, 't.parent_thread_id IS NULL')) + ORDINAL_GAP;

        for (let i = 0; i < input.threadTitles.length; i++) {
          const brief = input.threadTitles[i];
          const authored = input.stepsByThread?.[i];
          const threadGroup = await threadGroups.save(
            threadGroups.create({
              job_id: input.jobId,
              org_id: input.orgId,
              ordinal: threadGroupOrdinal,
              kind: 'build',
              title: brief,
              type: input.threadTypes?.[i] ?? null,
              decision_record_id: record.id,
              config: {},
            }),
          );
          threadGroupOrdinal += ORDINAL_GAP;
          await threads.save(
            threads.create({
              thread_group_id: threadGroup.id,
              job_id: input.jobId,
              org_id: input.orgId,
              role: 'builder',
              ordinal: threadOrdinal,
              brief,
              type: coerceThreadType(input.threadTypes?.[i]),
              plan: authored?.length ? renderPlan(authored) : null,
              handoff_in: null,
              handoff_out: null,
              status: 'pending',
            }),
          );
          threadOrdinal += ORDINAL_GAP;
        }

        const masterThreadGroup = await threadGroups.save(
          threadGroups.create({
            job_id: input.jobId,
            org_id: input.orgId,
            ordinal: threadGroupOrdinal,
            kind: 'master_review',
            title: null,
            type: null,
            decision_record_id: record.id,
            config: {},
          }),
        );
        await threads.save(
          threads.create({
            thread_group_id: masterThreadGroup.id,
            job_id: input.jobId,
            org_id: input.orgId,
            role: 'master_review',
            ordinal: threadOrdinal,
            brief: 'Master review — whole-diff review & fix',
            type: 'general',
            plan: null,
            handoff_in: null,
            handoff_out: null,
            status: 'pending',
          }),
        );
      }

      await jobs.update(
        { id: input.jobId },
        {
          kind: input.kind,
          title,
          status: input.status ?? 'awaiting_approval',
          decision_record_id: record.id,
        },
      );

      return record.id;
    });

    const thread = await this.loadJob(input.jobId);
    return { thread, decisionRecordId };
  }

  async ensurePlanningThreadGroup(jobId: string, orgId: string): Promise<void> {
    await this.jobBootstrap?.ensurePlanningThreadGroup(jobId, orgId);
  }

  async loadDecisionRecord(decisionRecordId: string): Promise<{
    overview: string;
    decisions: Decision[];
    threadTitles: string[];
  } | null> {
    const row = await this.records.findOne({ where: { id: decisionRecordId } });
    if (!row) return null;
    return {
      overview: row.overview,
      decisions: row.decisions ?? [],
      threadTitles: row.thread_titles ?? [],
    };
  }

  async approve(
    jobId: string,
    clickedDecisionRecordId: string,
    approvedBy: string,
    buildPath: 'direct' | 'plan',
  ): Promise<Job | null> {
    return this.dataSource.transaction(async (m) => {
      const now = new Date();
      const jobRes = await m.getRepository(JobEntity).update(
        {
          id: jobId,
          status: 'awaiting_approval',
          decision_record_id: clickedDecisionRecordId,
        },
        { status: 'running', halt: null, build_path: buildPath },
      );
      if ((jobRes.affected ?? 0) !== 1) return null;
      await m
        .getRepository(DecisionRecordEntity)
        .update(
          { id: clickedDecisionRecordId },
          { status: 'approved', approved_by: approvedBy, approved_at: now },
        );
      const row = await m.getRepository(JobEntity).findOneOrFail({ where: { id: jobId } });
      return toThread(row);
    });
  }

  async withdrawPlan(jobId: string, reason?: string): Promise<{ withdrawn: boolean }> {
    return this.dataSource.transaction(async (m) => {
      const res = await m
        .getRepository(JobEntity)
        .update({ id: jobId, status: 'awaiting_approval' }, { status: 'planning' });
      if ((res.affected ?? 0) !== 1) return { withdrawn: false };
      await m
        .getRepository(DecisionRecordEntity)
        .update({ job_id: jobId, status: 'draft' }, { status: 'superseded' });
      return { withdrawn: true };
    });
  }

  async reopenPlanning(jobId: string): Promise<void> {
    await this.jobs.update({ id: jobId }, { status: 'planning' });
  }

  async buildNotStarted(jobId: string): Promise<boolean> {
    const row = await this.jobs.findOne({ where: { id: jobId } });
    if (!row) return false;
    if (row.build_path === 'direct') {
      return row.direct_build_started_at == null;
    }
    const threads = await this.threads.find({ where: { job_id: jobId } });
    return threads
      .filter((t) => t.parent_thread_id == null && isDriverExecutableKind(t.role))
      .every((t) => t.status === 'pending');
  }

  async cancel(jobId: string): Promise<void> {
    await this.jobs.update({ id: jobId }, { status: 'cancelled' });
    await this.jobDeps
      .onBlockerResolved(jobId, 'cancelled')
      .catch((err) => this.logger.warn(`cancel: wake funnel failed for blocker ${jobId}: ${err}`));
  }

  async loadJob(jobId: string): Promise<Job> {
    const row = await this.jobs.findOneOrFail({ where: { id: jobId } });
    return toThread(row);
  }

  async createFollowUpJob(input: {
    orgId: string;
    repoId: string;
    title: string | null;
    baseBranch: string | null;
    kind?: JobKind | null;
    createdByJobId?: string | null;
    createdByTitle?: string | null;
    autoMode?: CreateJobAutoMode;
  }): Promise<string> {
    const title =
      input.title && input.kind !== 'onboarding'
        ? await this.titler.titleFor(input.title, input.orgId)
        : input.title;
    let autoCols: Partial<JobEntity> = {};
    if (input.autoMode) {
      const org = await this.organizations.findOne({
        where: { id: input.orgId },
      });
      const approveMode = input.autoMode.approveMode ?? org?.default_auto_approve_mode ?? 'off';
      const merge = input.autoMode.merge ?? org?.default_auto_merge ?? false;
      autoCols = {
        auto_approve_mode: approveMode,
        auto_approve_by: null,
        auto_merge: merge,
        auto_merge_by: null,
      };
    }
    const row = await this.jobs.save(
      this.jobs.create({
        org_id: input.orgId,
        repo_id: input.repoId,
        origin: 'control',
        surface_thread_ref: null,
        title,
        base_branch: input.baseBranch,
        ...(input.kind ? { kind: input.kind } : {}),
        created_by_job_id: input.createdByJobId ?? null,
        created_by: input.createdByJobId
          ? { jobId: input.createdByJobId, title: input.createdByTitle ?? null }
          : null,
        ...autoCols,
      }),
    );
    await this.ensurePlanningThreadGroup(row.id, input.orgId);
    return row.id;
  }
}

function toThread(row: JobEntity): Job {
  return {
    id: row.id,
    orgId: row.org_id,
    repoId: row.repo_id,
    origin: row.origin as Job['origin'],
    surfaceThreadRef: row.surface_thread_ref,
    title: row.title,
    baseBranch: row.base_branch,
    kind: row.kind as JobKind | null,
    buildPath: row.build_path,
    status: row.status as Job['status'],
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
