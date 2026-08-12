import { Injectable } from '@nestjs/common';
import {
  EThreadStatus,
  type EEngine,
  type EPhaseKind,
  type EThreadRole,
} from '../generated/prisma/enums.js';
import type { Thread } from '../generated/prisma/client.js';
import { PrismaService } from './prisma.service.js';

export type ThreadRow = Thread & {
  phaseKind: EPhaseKind;
  /** The phase's own title where it has one; the list falls back to the kind. */
  phaseTitle: string | null;
  /** Ordinal of the owning phase, so a consumer can order without re-reading the phases. */
  phaseOrdinal: number;
  /**
   * What this thread actually RAN on, read off its first session rather than off today's role
   * table — history stays truthful when the bindings later change. Null until it opens one.
   */
  engine: EEngine | null;
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
    const phases = await this.prismaService.phase.findMany({
      where: { jobId },
      orderBy: { ordinal: 'asc' },
      include: {
        threads: {
          orderBy: { createdAt: 'asc' },
          include: {
            _count: { select: { messages: true, sessions: true } },
            // The FIRST session, not the active one: a thread's engine is frozen when it opens and
            // never changes, and the first is the only one guaranteed to exist on a closed thread.
            sessions: { orderBy: { ordinal: 'asc' }, take: 1, select: { engine: true } },
          },
        },
      },
    });

    return phases.flatMap((phase) =>
      phase.threads.map(({ _count, sessions, ...thread }) => ({
        ...thread,
        phaseKind: phase.kind,
        phaseTitle: phase.title,
        phaseOrdinal: phase.ordinal,
        engine: sessions[0]?.engine ?? null,
        messageCount: _count.messages,
        sessionCount: _count.sessions,
      })),
    );
  }

  async create(args: { phaseId: string; role: EThreadRole }): Promise<Thread> {
    return this.prismaService.thread.create({
      data: { phaseId: args.phaseId, role: args.role },
    });
  }

  /** Named: two ids of the same type, and transposing them writes a thread id into a session slot. */
  async setActiveSession(args: { threadId: string; sessionId: string }): Promise<void> {
    await this.prismaService.thread.update({
      where: { id: args.threadId },
      data: { activeSessionId: args.sessionId },
    });
  }

  async close(threadId: string): Promise<void> {
    await this.prismaService.thread.update({
      where: { id: threadId },
      data: { status: EThreadStatus.closed, closedAt: new Date() },
    });
  }
}
