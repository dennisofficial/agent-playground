import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import type {
  EventKind,
  EventMessage,
  EventSeverity,
  Message,
  MessageType,
  SeedRow,
  TurnEnvelope,
} from '@shared/domain';
import type { JobProvenance } from '@shared/domain/job';
import { chunkKey } from '@shared/prompt-kit/harness/chunk-keys';
import { fromExternal } from '@shared/prompt-kit/message';
import { DataSource, In, IsNull, QueryFailedError, Repository } from 'typeorm';
import { JobBootstrapService } from '../job-bootstrap/job-bootstrap.service';
import { DB_CONNECTION } from '../persistence/database.module';
import { InboundMessageEntity, JobEntity, TranscriptMessageEntity } from '../persistence/entities';
import { writeSystemChunk } from '../persistence/system-chunk-writer';
import {
  renderBornBlockedProvenanceNote,
  renderMidFlightBlockedNote,
} from '../prompt-kit/harness/seed-catalog';
import { SYSTEM_SEED_AUTHOR } from '../surface/chat-surface.port';
import {
  MESSAGE_CHANGE_NOTIFIER,
  type MessageChangeNotifier,
} from '../surface/message-change-notifier.port';

type ReplyRouteJson = NonNullable<InboundMessageEntity['reply_route']> & {
  seedQuestionId?: string;
  seedSecretId?: string;
  seedFileId?: string;
  seedQuestionIds?: string[];
  seedSecretIds?: string[];
  seedFileIds?: string[];
  bornBlockedSeed?: boolean;
  blockNote?: boolean;
  unblockNote?: boolean;
};

export class DuplicateStimulusError extends Error {
  constructor(public readonly dedupeKey: string) {
    super(`Duplicate event stimulus for dedupe_key=${dedupeKey}`);
    this.name = 'DuplicateStimulusError';
  }
}

const PG_UNIQUE_VIOLATION = '23505';

const HOST_SEED_AUTHOR = { id: 'U-SYSTEM', displayName: 'System' } as const;

@Injectable()
export class StimulusStoreService {
  private readonly logger = new Logger(StimulusStoreService.name);

  constructor(
    @InjectRepository(JobEntity, DB_CONNECTION)
    private readonly jobs: Repository<JobEntity>,
    @InjectRepository(TranscriptMessageEntity, DB_CONNECTION)
    private readonly messages: Repository<TranscriptMessageEntity>,
    @InjectRepository(InboundMessageEntity, DB_CONNECTION)
    private readonly stimuli: Repository<InboundMessageEntity>,
    @InjectDataSource(DB_CONNECTION)
    private readonly dataSource: DataSource,
    @Optional() private readonly jobBootstrap?: JobBootstrapService,
    @Optional()
    @Inject(MESSAGE_CHANGE_NOTIFIER)
    private readonly notifier?: MessageChangeNotifier,
  ) {}

  private async planningThreadId(jobId: string): Promise<string> {
    if (!this.jobBootstrap) throw new Error('stimulus-store: JobBootstrapService not wired');
    return this.jobBootstrap.planningThreadId(jobId);
  }

  async attachEventToJob(input: {
    jobId: string;
    orgId: string;
    repoId: string;
    source: string;
    dedupeKey: string;
    severity: EventSeverity;
    eventKind: EventKind;
    body: string;
    card?: Record<string, unknown>;
  }): Promise<EventMessage> {
    await this.jobBootstrap?.ensurePlanningThreadGroup(input.jobId, input.orgId);
    const ciThreadId = (await this.jobBootstrap?.ciThreadId(input.jobId)) ?? null;
    const threadId = ciThreadId ?? (await this.planningThreadId(input.jobId));
    const lane = ciThreadId ? `thread:${ciThreadId}` : undefined;
    let row: InboundMessageEntity;
    try {
      row = await this.dataSource.transaction(async (m) => {
        await m.save(
          m.create(TranscriptMessageEntity, {
            job_id: input.jobId,
            thread_id: threadId,
            author: input.source,
            author_id: input.source,
            author_bot_id: null,
            text: input.body,
            card: input.card ?? null,
            meta: {
              source: 'system_event',
              eventSource: input.source,
              severity: input.severity,
              eventKind: input.eventKind,
            },
          }),
        );
        return m.save(
          m.create(InboundMessageEntity, {
            org_id: input.orgId,
            repo_id: input.repoId,
            kind: 'event',
            type: 'event',
            trust: 'untrusted',
            body: input.body,
            job_id: input.jobId,
            author_id: null,
            reply_route: null,
            source: input.source,
            dedupe_key: input.dedupeKey,
            severity: input.severity,
            ...(lane ? { lane } : {}),
          }),
        );
      });
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw new DuplicateStimulusError(input.dedupeKey);
      }
      throw err;
    }

    return {
      id: row.id,
      type: 'event',
      trust: 'untrusted',
      orgId: input.orgId,
      repoId: input.repoId,
      jobId: input.jobId,
      body: input.body,
      source: input.source,
      eventKind: input.eventKind,
      dedupeKey: input.dedupeKey,
      severity: input.severity,
      receivedAt: row.created_at.toISOString(),
      ...(ciThreadId ? { resumeThreadId: ciThreadId } : {}),
    };
  }

  async findOwningJobByBranch(
    orgId: string,
    repoId: string,
    branch: string,
  ): Promise<JobEntity | null> {
    return this.jobs
      .createQueryBuilder('j')
      .where('j.org_id = :orgId', { orgId })
      .andWhere('j.repo_id = :repoId', { repoId })
      .andWhere('(j.feature_branch = :branch OR j.current_branch = :branch)', {
        branch,
      })
      .andWhere('j.status != :closed', { closed: 'closed' })
      .orderBy('j.created_at', 'DESC')
      .getOne();
  }

  async findOwningJobByPrNumber(
    orgId: string,
    repoId: string,
    prNumber: number,
  ): Promise<JobEntity | null> {
    return this.jobs
      .createQueryBuilder('j')
      .where('j.org_id = :orgId', { orgId })
      .andWhere('j.repo_id = :repoId', { repoId })
      .andWhere('j.pr_number = :prNumber', { prNumber })
      .orderBy('j.created_at', 'DESC')
      .getOne();
  }

  async recordChatStimulus(input: {
    orgId: string;
    repoId: string;
    jobId: string;
    author: { id: string; displayName: string };
    replyRoute: { surfaceId: string; jobRef: string };
    body: string;
    type?: MessageType;
    card?: Record<string, unknown>;
    priority?: 'now' | 'queue' | 'later';
    lane?: string;
    systemChunk?: SeedRow;
    operatorBubbleText?: string;
    bubbleAuthor?: { id: string; displayName: string };
    seedQuestionId?: string;
    seedSecretId?: string;
    seedFileId?: string;
    seedQuestionIds?: string[];
    seedSecretIds?: string[];
    seedFileIds?: string[];
    bornBlockedSeed?: boolean;
    blockNote?: boolean;
    unblockNote?: boolean;
  }): Promise<TurnEnvelope> {
    const type: MessageType | 'seed' =
      input.type ?? (input.author.id === SYSTEM_SEED_AUTHOR.id ? 'seed' : 'user');

    const replyRoute: ReplyRouteJson = {
      ...input.replyRoute,
      ...(input.priority ? { priority: input.priority } : {}),
      ...(input.seedQuestionId ? { seedQuestionId: input.seedQuestionId } : {}),
      ...(input.seedSecretId ? { seedSecretId: input.seedSecretId } : {}),
      ...(input.seedFileId ? { seedFileId: input.seedFileId } : {}),
      ...(input.seedQuestionIds?.length ? { seedQuestionIds: input.seedQuestionIds } : {}),
      ...(input.seedSecretIds?.length ? { seedSecretIds: input.seedSecretIds } : {}),
      ...(input.seedFileIds?.length ? { seedFileIds: input.seedFileIds } : {}),
      ...(input.bornBlockedSeed ? { bornBlockedSeed: input.bornBlockedSeed } : {}),
      ...(input.blockNote ? { blockNote: input.blockNote } : {}),
      ...(input.unblockNote ? { unblockNote: input.unblockNote } : {}),
    };

    if (!input.lane?.startsWith('thread:')) {
      await this.jobBootstrap?.ensurePlanningThreadGroup(input.jobId, input.orgId);
    }
    const threadId = input.lane?.startsWith('thread:')
      ? input.lane.slice('thread:'.length)
      : await this.planningThreadId(input.jobId);

    const row = await this.dataSource.transaction(async (m) => {
      let bubbleRow: TranscriptMessageEntity | undefined;
      if (input.operatorBubbleText !== undefined) {
        const bubbleAuthor = input.bubbleAuthor ?? input.author;
        bubbleRow = await m.save(
          m.create(TranscriptMessageEntity, {
            job_id: input.jobId,
            thread_id: threadId,
            author: bubbleAuthor.displayName,
            author_id: bubbleAuthor.id,
            author_bot_id: null,
            text: input.operatorBubbleText,
            card: input.card ?? null,
          }),
        );
      } else if (input.systemChunk === undefined) {
        bubbleRow = await m.save(
          m.create(TranscriptMessageEntity, {
            job_id: input.jobId,
            thread_id: threadId,
            author: input.author.displayName,
            author_id: input.author.id,
            author_bot_id: null,
            text: input.body,
            card: input.card ?? null,
          }),
        );
      } else if (input.systemChunk !== 'skip') {
        const desc = input.systemChunk;
        const isUntrusted = (desc.kind ?? 'system_notice') === 'untrusted';
        const fullBody = !isUntrusted && input.body !== desc.label ? input.body : undefined;
        await writeSystemChunk(m.getRepository(TranscriptMessageEntity), {
          jobId: input.jobId,
          threadId,
          kind: desc.kind ?? 'system_notice',
          text: fromExternal(desc.label),
          chunkKey: desc.chunkKey,
          ...(desc.untrustedSource ? { untrustedSource: desc.untrustedSource } : {}),
          ...(desc.severity ? { severity: desc.severity } : {}),
          ...(fullBody ? { fullBody: fromExternal(fullBody) } : {}),
          ...(desc.framing ? { framing: desc.framing } : {}),
          ...(input.type && input.type !== 'user' ? { seedType: input.type } : {}),
        });
      }

      const inbound = await m.save(
        m.create(InboundMessageEntity, {
          org_id: input.orgId,
          repo_id: input.repoId,
          kind: 'chat',
          type,
          trust: 'trusted',
          body: input.body,
          job_id: input.jobId,
          author_id: input.author.id,
          author_name: input.author.displayName,
          reply_route: replyRoute,
          source: null,
          dedupe_key: null,
          severity: null,
          ...(input.lane ? { lane: input.lane } : {}),
        }),
      );

      if (bubbleRow && type === 'user') {
        await m.update(TranscriptMessageEntity, bubbleRow.id, {
          stimulus_id: inbound.id,
        });
      }
      return inbound;
    });

    this.notifier?.emitMessagesChanged(input.repoId, input.jobId);

    const resumeThreadId = resumeThreadIdFromLane(input.lane);
    const deliveredQuestionIds = collapseDeliveredIds(input.seedQuestionId, input.seedQuestionIds);
    const deliveredSecretIds = collapseDeliveredIds(input.seedSecretId, input.seedSecretIds);
    const deliveredFileIds = collapseDeliveredIds(input.seedFileId, input.seedFileIds);
    return {
      message: reconstructMessage({
        id: row.id,
        orgId: input.orgId,
        repoId: input.repoId,
        jobId: input.jobId,
        receivedAt: row.created_at,
        type,
      }),
      id: row.id,
      orgId: input.orgId,
      repoId: input.repoId,
      jobId: input.jobId,
      receivedAt: row.created_at,
      author: input.author,
      replyRoute: input.replyRoute,
      body: input.body,
      ...(input.priority ? { priority: input.priority } : {}),
      ...(deliveredQuestionIds ? { deliveredQuestionIds } : {}),
      ...(deliveredSecretIds ? { deliveredSecretIds } : {}),
      ...(deliveredFileIds ? { deliveredFileIds } : {}),
      ...(input.card ? { card: input.card } : {}),
      ...(resumeThreadId ? { resumeThreadId } : {}),
    };
  }

  async recordBornBlockedSeedsIfAbsent(input: {
    orgId: string;
    repoId: string;
    jobId: string;
    brief: string;
    createdBy: JobProvenance | null;
  }): Promise<void> {
    if (
      await this.hasChatStimulusForSeedTarget(input.jobId, {
        bornBlockedSeed: true,
      })
    ) {
      return;
    }
    const author = {
      id: SYSTEM_SEED_AUTHOR.id,
      displayName: SYSTEM_SEED_AUTHOR.name,
    };
    const replyRoute = { surfaceId: 'web', jobRef: input.jobId };
    await this.recordChatStimulus({
      orgId: input.orgId,
      repoId: input.repoId,
      jobId: input.jobId,
      author,
      replyRoute,
      type: 'follow_up_job_seed',
      body: renderBornBlockedProvenanceNote(input.createdBy),
      lane: 'main',
      bornBlockedSeed: true,
      systemChunk: {
        label: 'Queued — starts when unblocked',
        chunkKey: chunkKey.bornBlockedSeed(input.jobId),
      },
    });
    await this.recordChatStimulus({
      orgId: input.orgId,
      repoId: input.repoId,
      jobId: input.jobId,
      author,
      replyRoute,
      type: 'follow_up_job_seed',
      body: input.brief,
      lane: 'main',
    });
  }

  async recordBlockedNoteIfAbsent(input: {
    orgId: string;
    repoId: string;
    jobId: string;
  }): Promise<void> {
    if (await this.hasChatStimulusForSeedTarget(input.jobId, { blockNote: true })) {
      return;
    }
    await this.recordChatStimulus({
      orgId: input.orgId,
      repoId: input.repoId,
      jobId: input.jobId,
      author: {
        id: SYSTEM_SEED_AUTHOR.id,
        displayName: SYSTEM_SEED_AUTHOR.name,
      },
      replyRoute: { surfaceId: 'web', jobRef: input.jobId },
      body: renderMidFlightBlockedNote(),
      lane: 'main',
      blockNote: true,
      systemChunk: {
        label: 'Blocked',
        chunkKey: chunkKey.blockNote(input.jobId),
      },
    });
  }

  async pendingBlockedPreview(jobId: string): Promise<string | null> {
    const rows = await this.pendingBlockedRows([jobId]);
    return pickBlockedPreview(rows);
  }

  async pendingLockedPreviews(jobIds: string[]): Promise<Map<string, string | null>> {
    const map = new Map<string, string | null>();
    if (jobIds.length === 0) return map;
    const rows = await this.pendingBlockedRows(jobIds);
    const byJob = new Map<string, InboundMessageEntity[]>();
    for (const r of rows) {
      const list = byJob.get(r.job_id as string) ?? [];
      list.push(r);
      byJob.set(r.job_id as string, list);
    }
    for (const jobId of jobIds) {
      map.set(jobId, pickBlockedPreview(byJob.get(jobId) ?? []));
    }
    return map;
  }

  private async pendingBlockedRows(jobIds: string[]): Promise<InboundMessageEntity[]> {
    return this.stimuli
      .createQueryBuilder('s')
      .where('s.kind = :k', { k: 'chat' })
      .andWhere('s.job_id IN (:...ids)', { ids: jobIds })
      .andWhere('s.delivered_at IS NULL')
      .andWhere("COALESCE(s.lane, 'main') = 'main'")
      .orderBy('s.created_at', 'ASC')
      .getMany();
  }

  async recordHostSeed(input: {
    orgId: string;
    repoId: string;
    jobId: string;
    lane: string;
    body: string;
    priority?: 'now' | 'queue' | 'later';
  }): Promise<TurnEnvelope> {
    const replyRoute = { surfaceId: 'web', jobRef: input.jobId };
    const row = await this.stimuli.save(
      this.stimuli.create({
        org_id: input.orgId,
        repo_id: input.repoId,
        kind: 'chat',
        type: 'seed',
        trust: 'trusted',
        body: input.body,
        job_id: input.jobId,
        author_id: HOST_SEED_AUTHOR.id,
        author_name: HOST_SEED_AUTHOR.displayName,
        reply_route: input.priority ? { ...replyRoute, priority: input.priority } : replyRoute,
        source: null,
        dedupe_key: null,
        severity: null,
        lane: input.lane,
      }),
    );

    const author = {
      id: HOST_SEED_AUTHOR.id,
      displayName: HOST_SEED_AUTHOR.displayName,
    };
    return {
      message: reconstructMessage({
        id: row.id,
        orgId: input.orgId,
        repoId: input.repoId,
        jobId: input.jobId,
        receivedAt: row.created_at,
        type: 'seed',
      }),
      id: row.id,
      orgId: input.orgId,
      repoId: input.repoId,
      jobId: input.jobId,
      receivedAt: row.created_at,
      author,
      replyRoute,
      body: input.body,
      ...(input.priority ? { priority: input.priority } : {}),
    };
  }


  async eligiblePendingChat(
    jobId: string,
    leaseMs: number,
    lane: string = 'main',
  ): Promise<TurnEnvelope[]> {
    const cutoff = new Date(Date.now() - leaseMs);
    const rows = await this.stimuli
      .createQueryBuilder('s')
      .where('s.kind = :k', { k: 'chat' })
      .andWhere('s.job_id = :j', { j: jobId })
      .andWhere("COALESCE(s.lane, 'main') = :lane", { lane })
      .andWhere('s.delivered_at IS NULL')
      .andWhere('(s.attempted_at IS NULL OR s.attempted_at < :cutoff)', {
        cutoff,
      })
      .orderBy('s.created_at', 'ASC')
      .getMany();
    return rows.map((r) => this.rowToEnvelope(r));
  }

  async leaseChatStimuli(ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    await this.stimuli.update({ id: In(ids) }, { attempted_at: new Date() });
  }

  async claimChatStimuli(ids: string[], leaseMs: number): Promise<string[]> {
    if (ids.length === 0) return [];
    const cutoff = new Date(Date.now() - leaseMs);
    const res = await this.stimuli
      .createQueryBuilder()
      .update()
      .set({ attempted_at: () => 'now()' })
      .where('id IN (:...ids)', { ids })
      .andWhere('delivered_at IS NULL')
      .andWhere('(attempted_at IS NULL OR attempted_at < :cutoff)', { cutoff })
      .returning('id')
      .execute();
    return (res.raw as Array<{ id: string }>).map((r) => r.id);
  }

  async markChatDelivered(id: string): Promise<void> {
    const row = await this.dataSource.transaction(async (m) => {
      const deliveredAt = new Date();
      const res = await m.update(
        InboundMessageEntity,
        { id, delivered_at: IsNull() },
        { delivered_at: deliveredAt },
      );
      if (!res.affected) return null; // already delivered or missing — idempotent no-op.
      const delivered = await m.findOne(InboundMessageEntity, {
        where: { id },
      });
      await m.update(
        TranscriptMessageEntity,
        { stimulus_id: id, delivered_at: IsNull() },
        { delivered_at: deliveredAt },
      );
      return delivered;
    });
    if (row) this.notifier?.emitMessagesChanged(row.repo_id, row.job_id as string);
  }

  async undeliveredChatForLane(jobId: string, lane: string): Promise<TurnEnvelope[]> {
    const rows = await this.stimuli
      .createQueryBuilder('s')
      .where('s.kind = :k', { k: 'chat' })
      .andWhere('s.job_id = :j', { j: jobId })
      .andWhere("COALESCE(s.lane, 'main') = :lane", { lane })
      .andWhere('s.delivered_at IS NULL')
      .orderBy('s.created_at', 'ASC')
      .getMany();
    return rows.map((r) => this.rowToEnvelope(r));
  }

  async rekeyLaneToMain(id: string, labeledBody: string): Promise<void> {
    await this.stimuli.update(
      { id, delivered_at: IsNull() },
      { lane: 'main', body: labeledBody, attempted_at: null },
    );
  }

  async findChatStimulusById(id: string): Promise<TurnEnvelope | null> {
    const row = await this.stimuli.findOne({ where: { id, kind: 'chat' } });
    return row ? this.rowToEnvelope(row) : null;
  }

  async hasChatStimulusForSeedTarget(
    jobId: string,
    target: {
      seedQuestionId?: string;
      seedSecretId?: string;
      seedFileId?: string;
      bornBlockedSeed?: boolean;
      blockNote?: boolean;
      unblockNote?: boolean;
    },
  ): Promise<boolean> {
    const qb = this.stimuli
      .createQueryBuilder('s')
      .where('s.kind = :k', { k: 'chat' })
      .andWhere('s.job_id = :j', { j: jobId })
      .andWhere('s.delivered_at IS NULL');
    let hasTarget = false;
    if (target.seedQuestionId) {
      qb.andWhere(
        "(s.reply_route ->> 'seedQuestionId' = :q OR jsonb_exists(s.reply_route -> 'seedQuestionIds', :q))",
        { q: target.seedQuestionId },
      );
      hasTarget = true;
    }
    if (target.seedSecretId) {
      qb.andWhere(
        "(s.reply_route ->> 'seedSecretId' = :sec OR jsonb_exists(s.reply_route -> 'seedSecretIds', :sec))",
        { sec: target.seedSecretId },
      );
      hasTarget = true;
    }
    if (target.seedFileId) {
      qb.andWhere(
        "(s.reply_route ->> 'seedFileId' = :f OR jsonb_exists(s.reply_route -> 'seedFileIds', :f))",
        { f: target.seedFileId },
      );
      hasTarget = true;
    }
    if (target.bornBlockedSeed) {
      qb.andWhere("s.reply_route ->> 'bornBlockedSeed' = 'true'");
      hasTarget = true;
    }
    if (target.blockNote) {
      qb.andWhere("s.reply_route ->> 'blockNote' = 'true'");
      hasTarget = true;
    }
    if (target.unblockNote) {
      qb.andWhere("s.reply_route ->> 'unblockNote' = 'true'");
      hasTarget = true;
    }
    if (!hasTarget) return false;
    return (await qb.getCount()) > 0;
  }

  async hasUndeliveredChat(jobId: string): Promise<boolean> {
    return this.stimuli
      .createQueryBuilder('s')
      .where('s.kind = :k', { k: 'chat' })
      .andWhere('s.job_id = :j', { j: jobId })
      .andWhere('s.delivered_at IS NULL')
      .andWhere("(s.reply_route ->> 'priority' IS NULL OR s.reply_route ->> 'priority' != 'later')")
      .getExists();
  }

  async undeliveredChatThreads(): Promise<Array<{ jobId: string; orgId: string; repoId: string }>> {
    const rows = await this.stimuli
      .createQueryBuilder('s')
      .select('s.job_id', 'job_id')
      .addSelect('s.org_id', 'org_id')
      .addSelect('s.repo_id', 'repo_id')
      .distinct(true)
      .where('s.kind = :k', { k: 'chat' })
      .andWhere('s.delivered_at IS NULL')
      .andWhere('s.job_id IS NOT NULL')
      .andWhere("(s.reply_route ->> 'priority' IS NULL OR s.reply_route ->> 'priority' != 'later')")
      .getRawMany<{ job_id: string; org_id: string; repo_id: string }>();
    return rows.map((r) => ({
      jobId: r.job_id,
      orgId: r.org_id,
      repoId: r.repo_id,
    }));
  }

  async undeliveredChatLanes(): Promise<
    Array<{ jobId: string; orgId: string; repoId: string; lane: string }>
  > {
    const rows = await this.stimuli
      .createQueryBuilder('s')
      .select('s.job_id', 'job_id')
      .addSelect('s.org_id', 'org_id')
      .addSelect('s.repo_id', 'repo_id')
      .addSelect("COALESCE(s.lane, 'main')", 'lane')
      .distinct(true)
      .where('s.kind = :k', { k: 'chat' })
      .andWhere('s.delivered_at IS NULL')
      .andWhere('s.job_id IS NOT NULL')
      .andWhere("(s.reply_route ->> 'priority' IS NULL OR s.reply_route ->> 'priority' != 'later')")
      .getRawMany<{
        job_id: string;
        org_id: string;
        repo_id: string;
        lane: string;
      }>();
    return rows.map((r) => ({
      jobId: r.job_id,
      orgId: r.org_id,
      repoId: r.repo_id,
      lane: r.lane,
    }));
  }

  async resetChatLeases(): Promise<void> {
    await this.stimuli.update({ kind: 'chat', delivered_at: IsNull() }, { attempted_at: null });
  }


  async eligiblePendingEvents(leaseMs: number): Promise<EventMessage[]> {
    const cutoff = new Date(Date.now() - leaseMs);
    const rows = await this.stimuli
      .createQueryBuilder('s')
      .where('s.kind = :k', { k: 'event' })
      .andWhere('s.delivered_at IS NULL')
      .andWhere('s.job_id IS NOT NULL')
      .andWhere('(s.attempted_at IS NULL OR s.attempted_at < :cutoff)', {
        cutoff,
      })
      .orderBy('s.created_at', 'ASC')
      .getMany();
    return rows.map((r) => this.rowToEventMessage(r));
  }

  async resetEventLeases(): Promise<void> {
    await this.stimuli.update({ kind: 'event', delivered_at: IsNull() }, { attempted_at: null });
  }

  private rowToEventMessage(row: InboundMessageEntity): EventMessage {
    const resumeThreadId = resumeThreadIdFromLane(row.lane);
    return {
      id: row.id,
      type: 'event',
      trust: 'untrusted',
      orgId: row.org_id,
      repoId: row.repo_id,
      jobId: row.job_id as string,
      body: row.body,
      source: row.source ?? 'webhook',
      eventKind: 'ci_failure',
      dedupeKey: row.dedupe_key ?? '',
      severity: (row.severity as EventSeverity | null) ?? 'info',
      receivedAt: row.created_at.toISOString(),
      ...(resumeThreadId ? { resumeThreadId } : {}),
    };
  }

  private rowToEnvelope(row: InboundMessageEntity): TurnEnvelope {
    const replyRoute: ReplyRouteJson | null = row.reply_route;
    const resumeThreadId = resumeThreadIdFromLane(row.lane);
    const author = {
      id: row.author_id ?? '',
      displayName: row.author_name ?? row.author_id ?? 'operator',
    };
    const deliveredQuestionIds = collapseDeliveredIds(
      replyRoute?.seedQuestionId,
      replyRoute?.seedQuestionIds,
    );
    const deliveredSecretIds = collapseDeliveredIds(
      replyRoute?.seedSecretId,
      replyRoute?.seedSecretIds,
    );
    const deliveredFileIds = collapseDeliveredIds(replyRoute?.seedFileId, replyRoute?.seedFileIds);
    return {
      message: reconstructMessage({
        id: row.id,
        orgId: row.org_id,
        repoId: row.repo_id,
        jobId: row.job_id as string,
        receivedAt: row.created_at,
        type: (row.type as string | null) ?? 'user',
      }),
      id: row.id,
      orgId: row.org_id,
      repoId: row.repo_id,
      jobId: row.job_id as string,
      receivedAt: row.created_at,
      author,
      replyRoute: row.reply_route ?? {
        surfaceId: '',
        jobRef: row.job_id as string,
      },
      body: row.body,
      ...(replyRoute?.priority ? { priority: replyRoute.priority } : {}),
      ...(deliveredQuestionIds ? { deliveredQuestionIds } : {}),
      ...(deliveredSecretIds ? { deliveredSecretIds } : {}),
      ...(deliveredFileIds ? { deliveredFileIds } : {}),
      ...(resumeThreadId ? { resumeThreadId } : {}),
    };
  }
}

function reconstructMessage(input: {
  id: string;
  orgId: string;
  repoId: string;
  jobId: string;
  receivedAt: Date;
  type: string;
}): Message {
  return {
    id: input.id,
    orgId: input.orgId,
    repoId: input.repoId,
    jobId: input.jobId,
    receivedAt: input.receivedAt.toISOString(),
    type: input.type,
  } as unknown as Message;
}

function collapseDeliveredIds(
  single: string | undefined,
  plural: string[] | undefined,
): string[] | undefined {
  const ids = new Set<string>();
  if (single) ids.add(single);
  for (const id of plural ?? []) ids.add(id);
  return ids.size ? [...ids] : undefined;
}

function resumeThreadIdFromLane(lane: string | null | undefined): string | undefined {
  return lane?.startsWith('thread:') ? lane.slice('thread:'.length) : undefined;
}

function pickBlockedPreview(rows: InboundMessageEntity[]): string | null {
  const flag = (r: InboundMessageEntity): ReplyRouteJson | null =>
    r.reply_route as ReplyRouteJson | null;
  const bornBlocked = rows.some((r) => flag(r)?.bornBlockedSeed);
  if (bornBlocked) {
    const brief = rows.find((r) => r.type === 'follow_up_job_seed' && !flag(r)?.bornBlockedSeed);
    return brief?.body ?? null;
  }
  const blockNote = rows.find((r) => flag(r)?.blockNote);
  return blockNote?.body ?? null;
}

function isUniqueViolation(err: unknown): boolean {
  return (
    err instanceof QueryFailedError &&
    (err as QueryFailedError & { code?: string }).code === PG_UNIQUE_VIOLATION
  );
}
