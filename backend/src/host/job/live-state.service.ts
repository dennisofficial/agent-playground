import { Injectable } from '@nestjs/common';
import { Db } from '@workspace/nestjs-rls/nest';
import type { InboundMessageView } from '@workspace/shared';
import { EInboundMessageStatus } from '@workspace/shared';
import { In } from 'typeorm';
import { InboundMessage } from '../../_lib/database/entities/inbound-message.entity';

@Injectable()
export class LiveStateService {
  constructor(private readonly db: Db) {}

  /** The "sent, not yet consumed" queue for a job — the composer's pending zone (streams via inbound realtime). */
  async listPendingInbound(jobId: string): Promise<InboundMessageView[]> {
    const rows = await this.db.scoped(InboundMessage).find({
      where: { jobId, status: In([EInboundMessageStatus.PENDING, EInboundMessageStatus.DRAFT]) },
      order: { createdAt: 'ASC' },
    });
    return rows.map((m) => this.toInboundView(m));
  }

  private toInboundView(m: InboundMessage): InboundMessageView {
    return {
      id: m.id,
      jobId: m.jobId,
      threadId: m.threadId,
      source: m.source,
      text: m.text,
      payload: m.payload,
      status: m.status,
      priority: m.priority,
      createdAt: m.createdAt.toISOString(),
    };
  }
}
