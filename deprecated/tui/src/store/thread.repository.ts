import { Injectable } from '@nestjs/common';
import {
  EThreadStatus,
  type EEngine,
  type EPhaseKind,
  type EThreadCondition,
  type EThreadRole,
} from '../generated/prisma/enums.js';
import type { Thread } from '../generated/prisma/client.js';
import { PrismaService } from './prisma.service.js';

/**
 * One thread reduced to what a row's CONDITION needs, at whichever level is asking. Carried per
 * thread rather than pre-unioned in SQL because the union is a pure rule (`domain/attention.ts`) and
 * a repository that folded it would be a second place to get the ordering wrong.
 */
export type ThreadFacts = {
  id: string;
  closed: boolean;
  lastMessageAt: Date | null;
  lastSeenAt: Date | null;
};

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
  /**
   * When the newest message landed. Compared against `Thread.lastSeenAt` to derive unread — the
   * timestamps are the fact, "unread" is only what the list calls the comparison.
   */
  lastMessageAt: Date | null;
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
            // The newest message, for read state. By `ordinal` rather than `createdAt` because two
            // messages of one turn can share a millisecond and the ordinal never ties.
            messages: { orderBy: { ordinal: 'desc' }, take: 1, select: { createdAt: true } },
          },
        },
      },
    });

    return phases.flatMap((phase) =>
      phase.threads.map(({ _count, sessions, messages, ...thread }) => ({
        ...thread,
        phaseKind: phase.kind,
        phaseTitle: phase.title,
        phaseOrdinal: phase.ordinal,
        engine: sessions[0]?.engine ?? null,
        messageCount: _count.messages,
        sessionCount: _count.sessions,
        lastMessageAt: messages[0]?.createdAt ?? null,
      })),
    );
  }

  /**
   * Every open project's threads, keyed by project — how the top list knows something two levels
   * down needs you. One query rather than one per project, and archived jobs are left out because
   * archiving is precisely the act of saying "stop showing me this".
   */
  async factsByProject(): Promise<Map<string, ThreadFacts[]>> {
    const threads = await this.prismaService.thread.findMany({
      where: { phase: { job: { archivedAt: null } } },
      select: {
        id: true,
        status: true,
        lastSeenAt: true,
        phase: { select: { job: { select: { projectId: true } } } },
        messages: { orderBy: { ordinal: 'desc' }, take: 1, select: { createdAt: true } },
      },
    });

    const byProject = new Map<string, ThreadFacts[]>();
    for (const thread of threads) {
      const projectId = thread.phase.job.projectId;
      const facts = byProject.get(projectId) ?? [];
      facts.push({
        id: thread.id,
        closed: thread.status === EThreadStatus.closed,
        lastMessageAt: thread.messages[0]?.createdAt ?? null,
        lastSeenAt: thread.lastSeenAt,
      });
      byProject.set(projectId, facts);
    }
    return byProject;
  }

  async create(args: { phaseId: string; role: EThreadRole }): Promise<Thread> {
    return this.prismaService.thread.create({
      data: { phaseId: args.phaseId, role: args.role },
    });
  }

  /**
   * Which threads are still open in a phase, as rows — what the cursor rule reads when one closes.
   *
   * Rows rather than ids, unlike `JobRepository.openThreadIdsInPhase`: the question here is *where
   * does the human go next*, and answering it needs each candidate's opener and age. The two live
   * apart because they are asked by different holders — that one is asked of a PHASE (is it
   * finished), this one of the threads inside it.
   */
  async openInPhase(phaseId: string): Promise<Thread[]> {
    return this.prismaService.thread.findMany({
      where: { phaseId, status: { not: EThreadStatus.closed } },
      orderBy: { createdAt: 'asc' },
    });
  }

  /**
   * Records that one thread is waiting on another — `openedByThreadId`, never `parentThreadId`.
   * They mean different things: this says *I am a real thread in this phase and X is waiting on me*,
   * where the other says *I am a teammate*. Conflating them would hide the row from the thread list.
   *
   * Returns the updated row so the caller seeds the thread it actually wrote, not the one it read.
   */
  async setOpenedBy(args: {
    threadId: string;
    openedByThreadId: string;
  }): Promise<Thread> {
    return this.prismaService.thread.update({
      where: { id: args.threadId },
      data: { openedByThreadId: args.openedByThreadId },
    });
  }

  /** Named: two ids of the same type, and transposing them writes a thread id into a session slot. */
  async setActiveSession(args: { threadId: string; sessionId: string }): Promise<void> {
    await this.prismaService.thread.update({
      where: { id: args.threadId },
      data: { activeSessionId: args.sessionId },
    });
  }

  /**
   * You reached the BOTTOM of this thread. Not "you opened it" — mounting a four-hundred-message
   * transcript must not mark it read, or read state would only ever say "have you clicked on it".
   *
   * `at` is a parameter so the caller can stamp the moment it observed the bottom rather than the
   * moment the write got its turn on the connection; a turn finishing in between would otherwise be
   * marked seen by a write that started before it landed.
   */
  async markSeen(args: { threadId: string; at: Date }): Promise<void> {
    await this.prismaService.thread.update({
      where: { id: args.threadId },
      data: { lastSeenAt: args.at },
    });
  }

  async close(threadId: string): Promise<void> {
    await this.prismaService.thread.update({
      where: { id: threadId },
      data: { status: EThreadStatus.closed, closedAt: new Date() },
    });
  }

  /**
   * HOW it closed, and in whose words. Written beside `close()` rather than through it because the
   * status is ended by the session manager — which knows about sessions and accounts and nothing
   * about why a thread is finished — while the condition is known only to the verb that closed it.
   *
   * Every close path stamps one: a closed row with a null condition is precisely the row you would
   * have to read a transcript to interpret, which is what the column exists to prevent.
   */
  async recordOutcome(args: {
    threadId: string;
    condition: EThreadCondition;
    /** The closing agent's own words. Absent where nothing was written — never invented. */
    resolution?: string;
  }): Promise<void> {
    await this.prismaService.thread.update({
      where: { id: args.threadId },
      data: {
        condition: args.condition,
        ...(args.resolution === undefined ? {} : { resolution: args.resolution }),
      },
    });
  }
}
