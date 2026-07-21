import { InjectFlowProducer } from '@nestjs/bullmq';
import { Injectable } from '@nestjs/common';
import { Db } from '@workspace/nestjs-rls/nest';
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
import { FlowProducer } from 'bullmq';
import { Job } from '../../_lib/database/entities/job.entity';
import { Repo } from '../../_lib/database/entities/repo.entity';
import { ThreadGroup } from '../../_lib/database/entities/thread-group.entity';
import { Thread } from '../../_lib/database/entities/thread.entity';
import type { CreateJobDto } from '@workspace/shared';
import type { User } from '../../_lib/database/entities/user.entity';
import { InboundMessageService } from '../inbound-message/inbound-message.service';
import { buildTurnFlow } from './turn-flow';

export type CreateJobResult = { jobId: string; focusedThreadId: string };

@Injectable()
export class JobBootstrapService {
  constructor(
    private readonly db: Db,
    private readonly inbound: InboundMessageService,
    @InjectFlowProducer() private readonly flowProducer: FlowProducer,
  ) {}

  async create(dto: CreateJobDto, user: User): Promise<CreateJobResult> {
    // Authorize the write against the target repo (and, transitively, the org) before creating anything.
    await this.db.scoped(Repo).assertAccess({ id: dto.repoId, orgId: dto.orgId });

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

        return { jobId: job.id, focusedThreadId: thread.id };
      });

    await this.inbound.enqueue({
      jobId,
      threadId: focusedThreadId,
      orgId: dto.orgId,
      authorId: user.id,
      author: user.name?.trim() || user.email,
      source: EThreadMessageSource.OPERATOR,
      text: dto.firstMessage,
      priority: EInboundPriority.NOW,
    });

    await this.flowProducer.add(buildTurnFlow(jobId));

    return { jobId, focusedThreadId };
  }
}
