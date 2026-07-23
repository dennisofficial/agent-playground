import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Db } from '@workspace/nestjs-rls/nest';
import type {
  CreateJobDto,
  CreateJobResult,
  SendMessageDto,
  SendMessageResult,
} from '@workspace/shared';
import {
  EJobStatus,
  EThreadGroupKind,
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
import { IntakeService } from './intake.service';

@Injectable()
export class JobBootstrapService {
  constructor(
    private readonly db: Db,
    private readonly intake: IntakeService,
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

        // Enqueue the trigger message in the SAME transaction as the job/thread — a job never exists without
        // its first inbound row (the reconciler's "job has PENDING work" invariant stays exact).
        await this.intake.enqueueBatch(
          { jobId: job.id, threadId: thread.id, orgId: dto.orgId, authorId: user.id },
          [{ type: 'operator', text: dto.firstMessage }],
          m,
        );

        return { jobId: job.id, focusedThreadId: thread.id };
      });

    // Kick AFTER the transaction commits — a flow started against uncommitted rows would claim nothing.
    await this.intake.kick(jobId);

    return { jobId, focusedThreadId };
  }

  async sendMessage(jobId: string, user: User, dto: SendMessageDto): Promise<SendMessageResult> {
    const job = await this.db.scoped(Job).findOneScoped({ id: jobId }, 'update');
    if (!job) throw new NotFoundException('Job not found');
    if (job.archivedAt) throw new BadRequestException('Job is archived');

    const threadId = dto.threadId ?? job.focusedThreadId;
    if (!threadId) throw new BadRequestException('Job has no thread to post to');

    // Same intake pipeline as job-create and any other source — one durable row per item, then a flow kick.
    const messageIds = await this.intake.receive(
      { jobId, threadId, orgId: job.orgId, authorId: user.id },
      dto.messages,
    );

    return { messageIds };
  }
}
