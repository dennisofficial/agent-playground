import { Injectable } from '@nestjs/common';
import { EThreadStatus, type EGroupKind, type EThreadRole } from '../generated/prisma/enums.js';
import type { Thread } from '../generated/prisma/client.js';
import { PrismaService } from './prisma.service.js';

export type ThreadRow = Thread & {
  groupKind: EGroupKind;
  messageCount: number;
  sessionCount: number;
};

@Injectable()
export class ThreadRepository {
  constructor(private readonly prismaService: PrismaService) {}

  async findById(id: string): Promise<Thread | null> {
    return this.prismaService.thread.findUnique({ where: { id } });
  }

  /**
   * One row per thread — per ROLE, now that legs are sessions. Ordered as a timeline, because
   * threads are sequential history and only the last is live.
   */
  async listForJob(jobId: string): Promise<ThreadRow[]> {
    const groups = await this.prismaService.threadGroup.findMany({
      where: { jobId },
      orderBy: { ordinal: 'asc' },
      include: {
        threads: {
          orderBy: { createdAt: 'asc' },
          include: { _count: { select: { messages: true, sessions: true } } },
        },
      },
    });

    return groups.flatMap((group) =>
      group.threads.map(({ _count, ...thread }) => ({
        ...thread,
        groupKind: group.kind,
        messageCount: _count.messages,
        sessionCount: _count.sessions,
      })),
    );
  }

  async create(args: { groupId: string; role: EThreadRole }): Promise<Thread> {
    return this.prismaService.thread.create({
      data: { groupId: args.groupId, role: args.role },
    });
  }

  async setActiveSession(threadId: string, sessionId: string): Promise<void> {
    await this.prismaService.thread.update({
      where: { id: threadId },
      data: { activeSessionId: sessionId },
    });
  }

  async close(threadId: string): Promise<void> {
    await this.prismaService.thread.update({
      where: { id: threadId },
      data: { status: EThreadStatus.closed, closedAt: new Date() },
    });
  }
}
