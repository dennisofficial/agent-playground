import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Db } from '@workspace/nestjs-rls/nest';
import type {
  CreateJobDto,
  CreateJobResult,
  InboundItemInput,
  SendMessageDto,
  SendMessageResult,
} from '@workspace/shared';
import {
  EInboundPriority,
  EJobStatus,
  EThreadGroupKind,
  EThreadMessageSource,
  EThreadOrigin,
  EThreadRole,
  EThreadStatus,
  EThreadType,
} from '@workspace/shared';
import { Job } from '../../_lib/database/entities/job.entity';
import { Repo } from '../../_lib/database/entities/repo.entity';
import { ThreadGroup } from '../../_lib/database/entities/thread-group.entity';
import { Thread } from '../../_lib/database/entities/thread.entity';
import type { User } from '../../_lib/database/entities/user.entity';
import {
  type EnqueueInput,
  InboundMessageService,
} from '../inbound-message/inbound-message.service';
import { TurnFlowService } from './turn-flow.service';

@Injectable()
export class JobBootstrapService {
  private readonly logger = new Logger(this.constructor.name);

  constructor(
    private readonly db: Db,
    private readonly inbound: InboundMessageService,
    private readonly turnFlow: TurnFlowService,
  ) {}

  async create(dto: CreateJobDto, user: User): Promise<CreateJobResult> {
    // Authorize the write against the target repo (and, transitively, the org) before creating anything.
    await this.db.scoped(Repo).assertAccess({ id: dto.repoId, orgId: dto.orgId });

    // Job rows AND the first inbound message commit together — a job never exists without its trigger
    // message (nor the reverse), so the reconciler's "job has a PENDING message" invariant is exact.
    const { jobId, focusedThreadId } = await this.db
      .unsafe(Job)
      .manager.transaction(async (m): Promise<CreateJobResult> => {
        const job = m.create(Job, {
          orgId: dto.orgId,
          repoId: dto.repoId,
          title: dto.title ?? null,
          origin: EThreadOrigin.CHAT,
          kind: dto.kind ?? null,
          status: EJobStatus.OPEN,
          focusedThreadId: null,
        });
        await m.save(job);

        const group = m.create(ThreadGroup, {
          jobId: job.id,
          orgId: dto.orgId,
          ordinal: 0,
          kind: EThreadGroupKind.PLANNING,
          title: 'Planning',
          status: EThreadStatus.PENDING,
        });
        await m.save(group);

        const thread = m.create(Thread, {
          jobId: job.id,
          threadGroupId: group.id,
          orgId: dto.orgId,
          role: EThreadRole.PLANNING,
          type: EThreadType.GENERAL,
          ordinal: 0,
          brief: 'Main',
          status: EThreadStatus.PENDING,
        });
        await m.save(thread);

        job.focusedThreadId = thread.id;
        await m.save(job);

        await this.inbound.enqueue(
          {
            jobId: job.id,
            threadId: thread.id,
            orgId: dto.orgId,
            authorId: user.id,
            author: user.name?.trim() || user.email,
            source: EThreadMessageSource.OPERATOR,
            text: dto.firstMessage,
            priority: EInboundPriority.NOW,
            payload: { type: 'operator' },
          },
          m,
        );

        return { jobId: job.id, focusedThreadId: thread.id };
      });

    try {
      await this.turnFlow.enqueue(jobId);
    } catch (err) {
      this.logger.warn(
        `flow enqueue failed for job ${jobId}; reconciler will recover: ${String(err)}`,
      );
    }

    return { jobId, focusedThreadId };
  }

  async sendMessage(jobId: string, user: User, dto: SendMessageDto): Promise<SendMessageResult> {
    const job = await this.db.scoped(Job).findOneScoped({ id: jobId }, 'update');
    if (!job) throw new NotFoundException('Job not found');
    if (job.archivedAt) throw new BadRequestException('Job is archived');

    const threadId = dto.threadId ?? job.focusedThreadId;
    if (!threadId) throw new BadRequestException('Job has no thread to post to');

    // One inbound row per typed item, committed together — the batch becomes this turn's trigger (claimPending
    // returns them as an array; the spec builder renders each per type into the prompt).
    const author = user.name?.trim() || user.email;
    const messageIds = await this.db.unsafe(Job).manager.transaction(async (m) => {
      const ids: string[] = [];
      for (const item of dto.messages) {
        const row = await this.inbound.enqueue(
          this.toEnqueue(item, { jobId, threadId, orgId: job.orgId, authorId: user.id, author }),
          m,
        );
        ids.push(row.id);
      }
      return ids;
    });

    try {
      await this.turnFlow.enqueue(jobId);
    } catch (err) {
      this.logger.warn(
        `flow enqueue failed for job ${jobId} on message; reconciler will recover: ${String(err)}`,
      );
    }

    return { messageIds };
  }

  /** Map a composer item to an inbound row: routing (`source`), a display `text`, and typed `payload`. */
  private toEnqueue(
    item: InboundItemInput,
    ctx: { jobId: string; threadId: string; orgId: string; authorId: string; author: string },
  ): EnqueueInput {
    const base = { ...ctx, priority: EInboundPriority.NOW };
    switch (item.type) {
      case 'operator':
        return {
          ...base,
          source: EThreadMessageSource.OPERATOR,
          text: item.text,
          payload: { type: 'operator' },
        };
      case 'answer_question':
        return {
          ...base,
          source: EThreadMessageSource.OPERATOR,
          text: item.answer,
          payload: { type: 'answer_question', questionId: item.questionId },
        };
      case 'file_answered':
        return {
          ...base,
          source: EThreadMessageSource.OPERATOR,
          text: `Attached ${item.filename}`,
          payload: {
            type: 'file_answered',
            requestId: item.requestId,
            filename: item.filename,
            content: item.content,
          },
        };
      case 'secret_provided':
        // Never persist the secret VALUE — only that one was provided. Routing to the MCP is future work.
        return {
          ...base,
          source: EThreadMessageSource.SYSTEM,
          text: 'Secret provided.',
          payload: { type: 'secret_provided', requestId: item.requestId },
        };
    }
  }
}
