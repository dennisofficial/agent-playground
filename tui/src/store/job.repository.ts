import { Injectable } from '@nestjs/common';
import { EGroupKind, EJobStatus, type EThreadRole } from '../generated/prisma/enums.js';
import type { Job, ThreadGroup } from '../generated/prisma/client.js';
import { ROLE_GROUP } from '../domain/role-engine.js';
import { PrismaService } from './prisma.service.js';

export type JobRow = Job & {
  activeRole: EThreadRole | null;
  activeGroup: EGroupKind | null;
  /** Across every thread in the job — what the delete prompt quotes, so the cost of `y` is legible. */
  messageCount: number;
};

@Injectable()
export class JobRepository {
  constructor(private readonly prismaService: PrismaService) {}

  async listForProject(projectId: string): Promise<JobRow[]> {
    const jobs = await this.prismaService.job.findMany({
      where: { projectId },
      orderBy: { updatedAt: 'desc' },
      include: {
        groups: { include: { threads: { include: { _count: { select: { messages: true } } } } } },
      },
    });

    return jobs.map((job) => {
      const threads = job.groups.flatMap((g) => g.threads.map((t) => ({ thread: t, group: g })));
      const active = threads.find((t) => t.thread.id === job.activeThreadId);
      const { groups: _groups, ...rest } = job;
      return {
        ...rest,
        activeRole: active?.thread.role ?? null,
        activeGroup: active?.group.kind ?? null,
        messageCount: threads.reduce((total, t) => total + t.thread._count.messages, 0),
      };
    });
  }

  /**
   * Which projects contain any of these threads — how the projects list knows an agent is working
   * two levels down. Asked of the database rather than plumbed through the turn runner, because the
   * runner deals in threads and has no reason to learn what a project is.
   */
  async projectIdsForThreads(threadIds: readonly string[]): Promise<string[]> {
    if (threadIds.length === 0) return [];
    const jobs = await this.prismaService.job.findMany({
      where: { groups: { some: { threads: { some: { id: { in: [...threadIds] } } } } } },
      select: { projectId: true },
    });
    return [...new Set(jobs.map((job) => job.projectId))];
  }

  async idsForProject(projectId: string): Promise<string[]> {
    const jobs = await this.prismaService.job.findMany({
      where: { projectId },
      select: { id: true },
    });
    return jobs.map((job) => job.id);
  }

  /**
   * The SDK's own session ids under a job — the key its raw tape is filed under. Read BEFORE the
   * delete, because after the cascade there is nothing left to ask.
   */
  async engineSessionIdsFor(jobId: string): Promise<string[]> {
    const sessions = await this.prismaService.engineSession.findMany({
      where: { thread: { group: { jobId } } },
      select: { engineSessionId: true },
    });
    return sessions
      .map((session) => session.engineSessionId)
      .filter((id): id is string => id !== null);
  }

  /** Groups, threads, sessions and messages all go with it, by `ON DELETE CASCADE`. */
  async remove(id: string): Promise<void> {
    await this.prismaService.job.delete({ where: { id } });
  }

  async findById(id: string): Promise<Job | null> {
    return this.prismaService.job.findUnique({ where: { id } });
  }

  /**
   * A new job starts with one group and one thread — the intake role. Structure is carried from
   * day one but v1 runs one of each; nothing here advances a group.
   */
  async create(args: { projectId: string; title: string; role: EThreadRole }): Promise<Job> {
    const kind = ROLE_GROUP[args.role];
    return this.prismaService.job.create({
      data: {
        projectId: args.projectId,
        title: args.title,
        groups: { create: { kind, ordinal: 0 } },
      },
    });
  }

  async setActiveThread(jobId: string, threadId: string): Promise<void> {
    await this.prismaService.job.update({
      where: { id: jobId },
      data: { activeThreadId: threadId },
    });
  }

  async setStatus(jobId: string, status: EJobStatus): Promise<void> {
    await this.prismaService.job.update({ where: { id: jobId }, data: { status } });
  }

  /** Groups exist as a column; this is the only thing that creates them. */
  async groupFor(jobId: string, kind: EGroupKind): Promise<ThreadGroup> {
    const existing = await this.prismaService.threadGroup.findFirst({ where: { jobId, kind } });
    if (existing) return existing;

    const last = await this.prismaService.threadGroup.findFirst({
      where: { jobId },
      orderBy: { ordinal: 'desc' },
    });
    return this.prismaService.threadGroup.create({
      data: { jobId, kind, ordinal: (last?.ordinal ?? -1) + 1 },
    });
  }
}
