import { PrismaService } from '@lib/prisma/prisma.service';
import { Injectable } from '@nestjs/common';
import {
  EInboundMessageStatus,
  EInboundMessageType,
  EInboundPriority,
  EThreadMessageSource,
  type EThreadMessageType,
  type InboundMessagePayload,
} from '@workspace/shared';
import type { Prisma } from '../../generated/prisma/client';
import type { InboundMessageModel } from '../../generated/prisma/models';

export type EnqueueInput = {
  jobId: string;
  threadId: string;
  orgId: string;
  authorId: string;
  source: EThreadMessageSource;
  text: string;
  priority: EInboundPriority;
  payload?: InboundMessagePayload | null;
};

/**
 * All data access here runs unscoped (`PrismaService`): the reconcile cron and the dispatch queue
 * processor have no caller in flight, and the request-driven callers (job archive, job-bootstrap)
 * only ever pass a `jobId` already proven visible to the caller by their own ScopedDb read — the
 * same trust boundary `db.unsafe(...)` had before this migration, not a new one.
 */
@Injectable()
export class InboundMessageService {
  constructor(private readonly prismaService: PrismaService) {}

  async enqueue(input: EnqueueInput, tx?: Prisma.TransactionClient): Promise<InboundMessageModel> {
    if (tx) return this.insert(tx, input);
    return this.prismaService.$transaction((t) => this.insert(t, input));
  }

  private async insert(
    tx: Prisma.TransactionClient,
    input: EnqueueInput,
  ): Promise<InboundMessageModel> {
    return tx.inboundMessage.create({
      data: {
        jobId: input.jobId,
        threadId: input.threadId,
        orgId: input.orgId,
        authorId: input.authorId,
        source: input.source,
        text: input.text,
        payload: input.payload ?? undefined,
        status: EInboundMessageStatus.PENDING,
        priority: input.priority,
        deliveredAt: null,
      },
    });
  }

  async consume(row: InboundMessageModel, tx?: Prisma.TransactionClient): Promise<void> {
    const run = async (t: Prisma.TransactionClient): Promise<void> => {
      // The bubble's authoritative type IS the intake type it arrived as (operator/answer/file/secret) — the
      // inbound payload's discriminant maps 1:1 onto EInboundMessageType (a subset of EThreadMessageType).
      const payload = row.payload as { type?: EInboundMessageType } | null;
      const type: EThreadMessageType = payload?.type ?? EInboundMessageType.OPERATOR;
      await t.threadMessage.create({
        data: {
          jobId: row.jobId,
          threadId: row.threadId,
          orgId: row.orgId,
          subagentId: null,
          source: row.source,
          authorId: row.authorId,
          text: row.text,
          type,
          card: undefined,
          meta: undefined,
          orderAt: null,
        },
      });
      await t.inboundMessage.update({
        where: { id: row.id },
        data: { status: EInboundMessageStatus.CONSUMED, deliveredAt: new Date() },
      });
    };
    if (tx) return run(tx);
    return this.prismaService.$transaction(run);
  }

  async claimPending(jobId: string): Promise<InboundMessageModel[]> {
    const pending = await this.prismaService.inboundMessage.findMany({
      where: { jobId, status: EInboundMessageStatus.PENDING },
      orderBy: { createdAt: 'asc' },
    });
    const hasTrigger = pending.some(
      (r) => r.priority === EInboundPriority.NOW || r.priority === EInboundPriority.QUEUED,
    );
    return hasTrigger ? pending : [];
  }

  async pendingExcluding(jobId: string, exclude: Set<string>): Promise<InboundMessageModel[]> {
    const rows = await this.prismaService.inboundMessage.findMany({
      where: { jobId, status: EInboundMessageStatus.PENDING },
      orderBy: { createdAt: 'asc' },
    });
    return rows.filter((r) => !exclude.has(r.id));
  }

  async pendingNowExcluding(jobId: string, exclude: Set<string>): Promise<InboundMessageModel[]> {
    const rows = await this.prismaService.inboundMessage.findMany({
      where: { jobId, status: EInboundMessageStatus.PENDING, priority: EInboundPriority.NOW },
      orderBy: { createdAt: 'asc' },
    });
    return rows.filter((r) => !exclude.has(r.id));
  }

  async hasPending(jobId: string): Promise<boolean> {
    const count = await this.prismaService.inboundMessage.count({
      where: {
        jobId,
        status: EInboundMessageStatus.PENDING,
        priority: { in: [EInboundPriority.NOW, EInboundPriority.QUEUED] },
      },
    });
    return count > 0;
  }

  async pendingJobIds(): Promise<string[]> {
    const rows = await this.prismaService.inboundMessage.findMany({
      where: {
        status: EInboundMessageStatus.PENDING,
        priority: { in: [EInboundPriority.NOW, EInboundPriority.QUEUED] },
        job: { archivedAt: null },
      },
      select: { jobId: true },
      distinct: ['jobId'],
    });
    return rows.map((r) => r.jobId);
  }

  /** Drain a job's PENDING queue when the job is archived — nothing more should be dispatched for it. */
  async discardPending(jobId: string): Promise<void> {
    await this.prismaService.inboundMessage.updateMany({
      where: { jobId, status: EInboundMessageStatus.PENDING },
      data: { status: EInboundMessageStatus.DELIVERED, deliveredAt: new Date() },
    });
  }
}
