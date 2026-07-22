import { Injectable, Logger } from '@nestjs/common';
import { Db } from '@workspace/nestjs-rls/nest';
import type { CreateJobDto, CreateJobResult } from '@workspace/shared';
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
import { InboundMessageService } from '../inbound-message/inbound-message.service';
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
}
