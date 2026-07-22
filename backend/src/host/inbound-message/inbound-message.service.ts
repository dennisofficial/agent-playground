import { Injectable } from '@nestjs/common';
import { Db } from '@workspace/nestjs-rls/nest';
import { EInboundMessageStatus, EInboundPriority, EThreadMessageSource } from '@workspace/shared';
import { EntityManager, In } from 'typeorm';
import {
  InboundMessage,
  InboundMessageRepo,
} from '../../_lib/database/entities/inbound-message.entity';
import { Job } from '../../_lib/database/entities/job.entity';
import { ThreadMessage } from '../../_lib/database/entities/thread-message.entity';

export type EnqueueInput = {
  jobId: string;
  threadId: string;
  orgId: string;
  authorId: string;
  author: string;
  source: EThreadMessageSource;
  text: string;
  priority: EInboundPriority;
  payload?: Record<string, unknown> | null;
};

@Injectable()
export class InboundMessageService {
  constructor(
    private readonly db: Db,
    private readonly inbound: InboundMessageRepo,
  ) {}

  async enqueue(input: EnqueueInput, manager?: EntityManager): Promise<InboundMessage> {
    if (manager) return this.insert(manager, input);
    return this.db.unsafe(InboundMessage).manager.transaction((m) => this.insert(m, input));
  }

  private async insert(m: EntityManager, input: EnqueueInput): Promise<InboundMessage> {
    const inbound = m.create(InboundMessage, {
      jobId: input.jobId,
      threadId: input.threadId,
      orgId: input.orgId,
      authorId: input.authorId,
      source: input.source,
      text: input.text,
      payload: input.payload ?? null,
      status: EInboundMessageStatus.PENDING,
      priority: input.priority,
      deliveredAt: null,
    });
    await m.save(inbound);

    const bubble = m.create(ThreadMessage, {
      jobId: input.jobId,
      threadId: input.threadId,
      orgId: input.orgId,
      subagentId: null,
      source: input.source,
      authorId: input.authorId,
      author: input.author,
      text: input.text,
      card: null,
      meta: null,
      orderAt: null,
    });
    await m.save(bubble);

    return inbound;
  }

  async claimPending(jobId: string): Promise<InboundMessage[]> {
    const pending = await this.db.unsafe(InboundMessage).find({
      where: { jobId, status: EInboundMessageStatus.PENDING },
      order: { createdAt: 'ASC' },
    });
    const hasTrigger = pending.some(
      (r) => r.priority === EInboundPriority.NOW || r.priority === EInboundPriority.QUEUED,
    );
    return hasTrigger ? pending : [];
  }

  async pendingExcluding(jobId: string, exclude: Set<string>): Promise<InboundMessage[]> {
    const rows = await this.db.unsafe(InboundMessage).find({
      where: { jobId, status: EInboundMessageStatus.PENDING },
      order: { createdAt: 'ASC' },
    });
    return rows.filter((r) => !exclude.has(r.id));
  }

  /** Mark a claimed batch as handed off to the engine. */
  async markDelivered(ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    await this.db
      .unsafe(InboundMessage)
      .update(
        { id: In(ids) },
        { status: EInboundMessageStatus.DELIVERED, deliveredAt: new Date() },
      );
  }

  async hasPending(jobId: string): Promise<boolean> {
    return this.db.unsafe(InboundMessage).exists({
      where: {
        jobId,
        status: EInboundMessageStatus.PENDING,
        priority: In([EInboundPriority.NOW, EInboundPriority.QUEUED]),
      },
    });
  }

  async pendingJobIds(): Promise<string[]> {
    const rows = await this.db
      .unsafe(InboundMessage)
      .createQueryBuilder('m')
      // Join the job so an archived job's stray PENDING rows can't resurrect it — without this the reconciler
      // re-provisions a sandbox for every archived job on every tick.
      .innerJoin(Job, 'j', 'j.id = m.jobId')
      .select('m.jobId', 'jobId')
      .distinct(true)
      .where('m.status = :status', { status: EInboundMessageStatus.PENDING })
      .andWhere('m.priority IN (:...priorities)', {
        priorities: [EInboundPriority.NOW, EInboundPriority.QUEUED],
      })
      .andWhere('j.archivedAt IS NULL')
      .getRawMany<{ jobId: string }>();
    return rows.map((r) => r.jobId);
  }

  /** Drain a job's PENDING queue when the job is archived — nothing more should be dispatched for it. */
  async discardPending(jobId: string): Promise<void> {
    await this.db
      .unsafe(InboundMessage)
      .update(
        { jobId, status: EInboundMessageStatus.PENDING },
        { status: EInboundMessageStatus.DELIVERED, deliveredAt: new Date() },
      );
  }
}
