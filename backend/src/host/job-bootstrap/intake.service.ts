import { Injectable, Logger } from '@nestjs/common';
import { Db } from '@workspace/nestjs-rls/nest';
import { EInboundPriority, EThreadMessageSource, type InboundItemInput } from '@workspace/shared';
import type { EntityManager } from 'typeorm';
import { InboundMessage } from '../../_lib/database/entities/inbound-message.entity';
import {
  type EnqueueInput,
  InboundMessageService,
} from '../inbound-message/inbound-message.service';
import { TurnFlowService } from './turn-flow.service';

/** Where a batch of intake lands: the job/thread it posts to and who authored it. */
export interface IntakeContext {
  jobId: string;
  threadId: string;
  orgId: string;
  authorId: string;
}

@Injectable()
export class IntakeService {
  private readonly logger = new Logger(this.constructor.name);

  constructor(
    private readonly db: Db,
    private readonly inbound: InboundMessageService,
    private readonly turnFlow: TurnFlowService,
  ) {}

  /** Standalone intake: enqueue the batch in its own transaction, then kick the flow. */
  async receive(ctx: IntakeContext, items: InboundItemInput[]): Promise<string[]> {
    const ids = await this.enqueueBatch(ctx, items);
    await this.kick(ctx.jobId);
    return ids;
  }

  async enqueueBatch(
    ctx: IntakeContext,
    items: InboundItemInput[],
    manager?: EntityManager,
  ): Promise<string[]> {
    const run = async (m: EntityManager): Promise<string[]> => {
      const ids: string[] = [];
      for (const item of items) {
        const row = await this.inbound.enqueue(this.toEnqueue(item, ctx), m);
        ids.push(row.id);
      }
      return ids;
    };
    if (manager) return run(manager);
    return this.db.unsafe(InboundMessage).manager.transaction(run);
  }

  async kick(jobId: string): Promise<void> {
    try {
      await this.turnFlow.enqueue(jobId);
    } catch (err) {
      this.logger.warn(
        `flow kick failed for job ${jobId}; reconciler will recover: ${String(err)}`,
      );
    }
  }

  private toEnqueue(item: InboundItemInput, ctx: IntakeContext): EnqueueInput {
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
