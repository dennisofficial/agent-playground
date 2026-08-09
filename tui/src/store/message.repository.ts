import { Injectable } from '@nestjs/common';
import type { Message, MessagePayload } from '../domain/message.js';
import type { EMessageType } from '../generated/prisma/enums.js';
import type { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from './prisma.service.js';

@Injectable()
export class MessageRepository {
  constructor(private readonly prismaService: PrismaService) {}

  /**
   * Ordering is THREAD-scoped, which is what makes the transcript continuous across a session
   * rotation with nothing to stitch. `@@unique([threadId, ordinal])` enforces it.
   */
  async listForThread(threadId: string): Promise<Message[]> {
    const rows = await this.prismaService.threadMessage.findMany({
      where: { threadId },
      orderBy: { ordinal: 'asc' },
    });
    return rows.map(toDomain);
  }

  async append(args: {
    threadId: string;
    sessionId: string;
    payload: MessagePayload;
  }): Promise<Message> {
    // Read-then-write, so it is only safe while appends do not overlap. TWO things guarantee that
    // and both are load-bearing: the soft lock in SessionRepository keeps other instances off this
    // conversation, and TurnRunnerService serialises its event handlers onto one chain. Concurrent
    // callers WILL collide on `@@unique([threadId, ordinal])` — that constraint is the backstop,
    // not the mechanism.
    const last = await this.prismaService.threadMessage.findFirst({
      where: { threadId: args.threadId },
      orderBy: { ordinal: 'desc' },
      select: { ordinal: true },
    });

    const row = await this.prismaService.threadMessage.create({
      data: {
        threadId: args.threadId,
        sessionId: args.sessionId,
        ordinal: (last?.ordinal ?? -1) + 1,
        type: args.payload.type,
        payload: args.payload as unknown as Prisma.InputJsonValue,
      },
    });
    return toDomain(row);
  }
}

type Row = {
  id: string;
  threadId: string;
  sessionId: string;
  ordinal: number;
  type: EMessageType;
  payload: Prisma.JsonValue;
  createdAt: Date;
};

/**
 * `payload` is stored normalised, never raw, so this is a cast rather than a translation. If it
 * ever needs to become a translation, normalisation has drifted and that is the bug.
 */
function toDomain(row: Row): Message {
  return {
    id: row.id,
    threadId: row.threadId,
    sessionId: row.sessionId,
    ordinal: row.ordinal,
    payload: row.payload as unknown as MessagePayload,
    createdAt: row.createdAt,
  };
}
