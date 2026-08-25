import { Injectable } from '@nestjs/common';
import type { TurnSummary, TurnUsage } from '../domain/message.js';
import { PrismaService } from './prisma.service.js';

/**
 * The turn ledger. One row per completed turn — see `prisma/schema/turn.prisma` for why the grain
 * is the turn and not the message.
 *
 * Nothing on the boot path reads more than the newest row, but the table is the whole history, so
 * per-thread totals are a `groupBy` away when they are wanted.
 */
@Injectable()
export class TurnRepository {
  constructor(private readonly prismaService: PrismaService) {}

  async record(args: {
    threadId: string;
    sessionId: string;
    startedAt: Date;
    durationMs: number;
    ok: boolean;
    usage?: TurnUsage;
  }): Promise<void> {
    const usage = args.usage;
    await this.prismaService.turn.create({
      data: {
        threadId: args.threadId,
        sessionId: args.sessionId,
        startedAt: args.startedAt,
        durationMs: args.durationMs,
        ok: args.ok,
        inputTokens: usage?.inputTokens ?? 0,
        outputTokens: usage?.outputTokens ?? 0,
        cacheReadTokens: usage?.cacheReadTokens ?? 0,
        cacheWriteTokens: usage?.cacheWriteTokens ?? 0,
        ...(usage?.costUsd === undefined ? {} : { costUsd: usage.costUsd }),
        ...(usage?.model === undefined ? {} : { model: usage.model }),
      },
    });
  }

  /** What the working line shows on open: the last thing this thread did, and what it cost. */
  async lastForThread(threadId: string): Promise<TurnSummary | null> {
    const row = await this.prismaService.turn.findFirst({
      where: { threadId },
      orderBy: { endedAt: 'desc' },
      select: { durationMs: true, outputTokens: true },
    });
    return row;
  }
}
