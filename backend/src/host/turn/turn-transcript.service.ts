import { ThreadMessage } from '@lib/database/entities/thread-message.entity';
import { Injectable, Logger } from '@nestjs/common';
import { Db } from '@workspace/nestjs-rls/nest';
import { EThreadMessageKind, EThreadMessageSource } from '@workspace/shared';

/** The thread a turn's output belongs to. */
export type TurnContext = { jobId: string; threadId: string; orgId: string };

/** Loose view of the raw SDK messages the engine forwards — we only read what we persist (assistant text). */
type EngineEvent = {
  type?: string;
  message?: { content?: Array<{ type?: string; text?: string }> };
};

@Injectable()
export class TurnTranscriptService {
  private readonly logger = new Logger(this.constructor.name);

  constructor(private readonly db: Db) {}

  async record(ctx: TurnContext, event: unknown): Promise<void> {
    const e = event as EngineEvent;
    if (e?.type !== 'assistant') return;
    for (const block of e.message?.content ?? []) {
      if (block?.type !== 'text') continue;
      const text = block.text?.trim();
      if (!text) continue;
      await this.db.unsafe(ThreadMessage).save(
        this.db.unsafe(ThreadMessage).create({
          jobId: ctx.jobId,
          threadId: ctx.threadId,
          orgId: ctx.orgId,
          subagentId: null,
          source: EThreadMessageSource.ATLAS,
          kind: EThreadMessageKind.CHAT,
          authorId: 'atlas',
          author: 'Atlas',
          text,
          card: null,
          meta: null,
          orderAt: null,
        }),
      );
    }
  }
}
