import { ScopedDb } from '@lib/pgbase/scoped-db';
import { PrismaService } from '@lib/prisma/prisma.service';
import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
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
import type { User } from '../../generated/prisma/client';
import { IntakeService } from './intake.service';

@Injectable()
export class JobBootstrapService {
  constructor(
    private readonly scopedDb: ScopedDb,
    private readonly prismaService: PrismaService,
    private readonly intake: IntakeService,
  ) {}

  async create(dto: CreateJobDto, user: User): Promise<CreateJobResult> {
    // Authorize the write against the target repo (and, transitively, the org) before creating anything.
    const repo = await this.scopedDb.repo.findFirst({ where: { id: dto.repoId, orgId: dto.orgId } });
    if (!repo) throw new NotFoundException('Repository not found');

    // Job rows AND the first inbound message commit together — a job never exists without its trigger
    // message (nor the reverse), so the reconciler's "job has a PENDING message" invariant is exact. No
    // caller-scoped transaction can span the four models this touches (ScopedDb has no $transaction), so
    // this runs unscoped with the org pinned to the repo we just confirmed the caller can see.
    const { jobId, focusedThreadId } = await this.prismaService.$transaction(
      async (tx): Promise<CreateJobResult> => {
        const job = await tx.job.create({
          data: {
            orgId: dto.orgId,
            repoId: dto.repoId,
            title: dto.title ?? null,
            origin: EThreadOrigin.CHAT,
            kind: dto.kind ?? null,
            status: EJobStatus.OPEN,
            focusedThreadId: null,
          },
        });

        const group = await tx.threadGroup.create({
          data: {
            jobId: job.id,
            orgId: dto.orgId,
            ordinal: 0,
            kind: EThreadGroupKind.PLANNING,
            title: 'Planning',
            status: EThreadStatus.PENDING,
          },
        });

        const thread = await tx.thread.create({
          data: {
            jobId: job.id,
            threadGroupId: group.id,
            orgId: dto.orgId,
            role: EThreadRole.PLANNING,
            type: EThreadType.GENERAL,
            ordinal: 0,
            brief: 'Main',
            status: EThreadStatus.PENDING,
          },
        });

        await tx.job.update({ where: { id: job.id }, data: { focusedThreadId: thread.id } });

        // Enqueue the trigger message in the SAME transaction as the job/thread — a job never exists without
        // its first inbound row (the reconciler's "job has PENDING work" invariant stays exact).
        await this.intake.enqueueBatch(
          { jobId: job.id, threadId: thread.id, orgId: dto.orgId, authorId: user.id },
          [{ type: 'operator', text: dto.firstMessage }],
          tx,
        );

        return { jobId: job.id, focusedThreadId: thread.id };
      },
    );

    // Kick AFTER the transaction commits — a flow started against uncommitted rows would claim nothing.
    await this.intake.kick(jobId);

    return { jobId, focusedThreadId };
  }

  async sendMessage(jobId: string, user: User, dto: SendMessageDto): Promise<SendMessageResult> {
    // ScopedDb's Job policy already excludes archived jobs from reads, so an archived (or foreign-org)
    // jobId lands here as a 404 rather than the old dedicated "Job is archived" 400 — see migration report.
    const job = await this.scopedDb.job.findUnique({ where: { id: jobId } });
    if (!job) throw new NotFoundException('Job not found');

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
