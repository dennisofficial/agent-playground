import { Injectable } from '@nestjs/common';
import type { ThreadMessageView } from '@workspace/shared';
import { In } from 'typeorm';
import { Subagent, SubagentRepo } from '../../_lib/database/entities/subagent.entity';
import {
  ThreadMessage,
  ThreadMessageRepo,
} from '../../_lib/database/entities/thread-message.entity';

@Injectable()
export class MessageService {
  constructor(
    private readonly messages: ThreadMessageRepo,
    private readonly subagents: SubagentRepo,
  ) {}

  /** One thread's transcript. */
  async listMessages(jobId: string, threadId: string): Promise<ThreadMessageView[]> {
    const rows = await this.messages.find({
      where: { jobId, threadId },
      order: { createdAt: 'ASC' },
    });
    return this.enrich(rows);
  }

  async listJobMessages(jobId: string): Promise<ThreadMessageView[]> {
    const rows = await this.messages.find({
      where: { jobId },
      order: { createdAt: 'ASC' },
    });
    return this.enrich(rows);
  }

  /** Map rows → views, deriving each anchor (Task-launching) message's subagent status/end time from the
   *  `subagents` row joined on `parentMessageId`. */
  private async enrich(rows: ThreadMessage[]): Promise<ThreadMessageView[]> {
    if (rows.length === 0) return [];
    const anchors = await this.subagents.find({
      where: { parentMessageId: In(rows.map((r) => r.id)) },
    });
    const byAnchor = new Map<string, Subagent>(anchors.map((s) => [s.parentMessageId, s]));
    return rows.map((r) => MessageService.toThreadMessageView(r, byAnchor.get(r.id) ?? null));
  }

  private static toThreadMessageView(
    m: ThreadMessage,
    anchoredSubagent: Subagent | null,
  ): ThreadMessageView {
    return {
      id: m.id,
      jobId: m.jobId,
      threadId: m.threadId,
      subagentId: m.subagentId,
      subagentStatus: anchoredSubagent ? anchoredSubagent.status : undefined,
      subagentEndedAt: anchoredSubagent?.endedAt
        ? anchoredSubagent.endedAt.toISOString()
        : undefined,
      source: m.source,
      isAtlas: m.source === 'atlas',
      authorId: m.authorId,
      author: m.author,
      text: m.text,
      kind: m.kind,
      card: m.card,
      meta: m.meta,
      orderAt: m.orderAt ? m.orderAt.toISOString() : null,
      postedAt: m.createdAt.toISOString(),
    };
  }
}
