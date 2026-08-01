import { PrismaService } from '@lib/prisma/prisma.service';
import { Injectable, Logger } from '@nestjs/common';
import {
  EThreadMessageSource,
  type EThreadMessageType,
  EThreadOutputType,
} from '@workspace/shared';
import type { Prisma } from '../../generated/prisma/client';

/** The thread a turn's output belongs to. */
export type TurnContext = { jobId: string; threadId: string; orgId: string };

/** Loose view of a raw SDK content block — only the fields we persist. */
interface ContentBlock {
  type?: string;
  text?: string;
  thinking?: string;
  id?: string;
  name?: string;
  input?: unknown;
  tool_use_id?: string;
  content?: unknown;
  is_error?: boolean;
}

/** Loose view of the raw SDK messages the engine forwards. */
interface EngineEvent {
  type?: string;
  /** Set on a subagent's messages — the spawning Task's tool_use id (drives web subagent peeling). */
  parent_tool_use_id?: string | null;
  message?: { content?: ContentBlock[] };
}

@Injectable()
export class TurnTranscriptService {
  private readonly logger = new Logger(this.constructor.name);

  constructor(private readonly prismaService: PrismaService) {}

  async record(ctx: TurnContext, event: unknown): Promise<void> {
    const e = event as EngineEvent;
    const content = e.message?.content;
    if (!Array.isArray(content)) return; // result / system / stream_event carry nothing to persist
    const pid = e.parent_tool_use_id ?? undefined;

    if (e.type === 'assistant') {
      for (const b of content) {
        if (b.type === 'text' && b.text?.trim()) {
          await this.write(ctx, EThreadOutputType.CHAT, b.text, this.meta(pid));
        } else if (b.type === 'thinking' && b.thinking?.trim()) {
          await this.write(ctx, EThreadOutputType.THINKING, b.thinking, this.meta(pid));
        } else if (b.type === 'tool_use') {
          await this.write(ctx, EThreadOutputType.TOOL, '', {
            id: b.id,
            name: b.name,
            input: b.input,
            ...(pid ? { parentToolUseId: pid } : {}),
          });
        }
      }
    } else if (e.type === 'user') {
      // The engine echoes tool results as `user` messages (operator/steering echoes carry string content and
      // fall through). Stitch each result onto its TOOL row so the call renders with its output.
      for (const b of content) {
        if (b.type === 'tool_result' && typeof b.tool_use_id === 'string') {
          await this.attachToolResult(ctx, b.tool_use_id, b.content, Boolean(b.is_error));
        }
      }
    }
  }

  private meta(pid?: string): Record<string, unknown> | null {
    return pid ? { parentToolUseId: pid } : null;
  }

  private async write(
    ctx: TurnContext,
    type: EThreadMessageType,
    text: string,
    meta: Record<string, unknown> | null,
  ): Promise<void> {
    await this.prismaService.threadMessage.create({
      data: {
        jobId: ctx.jobId,
        threadId: ctx.threadId,
        orgId: ctx.orgId,
        subagentId: null,
        source: EThreadMessageSource.ATLAS,
        type,
        authorId: 'atlas',
        text,
        card: undefined,
        meta: (meta ?? undefined) as Prisma.InputJsonValue | undefined,
        orderAt: null,
      },
    });
  }

  /** Stitch a `tool_result` onto its TOOL row (matched by the tool_use id in `meta.id`). */
  private async attachToolResult(
    ctx: TurnContext,
    toolUseId: string,
    result: unknown,
    isError: boolean,
  ): Promise<void> {
    const row = await this.prismaService.threadMessage.findFirst({
      where: {
        jobId: ctx.jobId,
        type: EThreadOutputType.TOOL,
        meta: { path: ['id'], equals: toolUseId },
      },
      orderBy: { createdAt: 'desc' },
    });
    if (!row) {
      this.logger.warn(`tool_result for unknown tool_use ${toolUseId} (job ${ctx.jobId})`);
      return;
    }
    await this.prismaService.threadMessage.update({
      where: { id: row.id },
      data: {
        meta: {
          ...((row.meta as Record<string, unknown>) ?? {}),
          result,
          isError,
        } as Prisma.InputJsonValue,
      },
    });
  }
}
