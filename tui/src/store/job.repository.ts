import { Injectable } from '@nestjs/common';
import { EThreadStatus, type EPhaseKind, type EThreadRole } from '../generated/prisma/enums.js';
import type { Job, Phase, Project } from '../generated/prisma/client.js';
import { PrismaService } from './prisma.service.js';
import type { ThreadFacts } from './thread.repository.js';

export type JobRow = Job & {
  activeRole: EThreadRole | null;
  activePhase: EPhaseKind | null;
  /**
   * Carried on every row, not just the unscoped ones. The list groups by project when it is showing
   * all of them, and a row that cannot name its own project would have to be joined back to one at
   * render time — which is the same query, done later, in a component.
   */
  projectName: string;
  /** Across every thread in the job — what the delete prompt quotes, so the cost of `y` is legible. */
  messageCount: number;
  /** What the job's condition is derived from — see `jobAttention`. */
  threads: ThreadFacts[];
};

@Injectable()
export class JobRepository {
  constructor(private readonly prismaService: PrismaService) {}

  /**
   * The jobs you are working on. Archived ones are hidden, never deleted — see `listArchived`.
   *
   * A null `projectId` means every project, which is the normal result of launching Atlas somewhere
   * that is not a repository. It is a wider query, not a different one: the rows are identical and
   * only the grouping above them changes.
   */
  async listForProject(projectId: string | null): Promise<JobRow[]> {
    return this.list({ projectId, archived: false });
  }

  /** The shelf. Same rows, same shaping — the only difference is which side of the filter they sit. */
  async listArchived(projectId: string | null): Promise<JobRow[]> {
    return this.list({ projectId, archived: true });
  }

  /**
   * `archived` is a filter, not a status: `Job.archivedAt` records WHEN it was shelved, so a job
   * keeps everything else it says about itself and the two lists are one query with one flag.
   */
  private async list(args: {
    projectId: string | null;
    archived: boolean;
  }): Promise<JobRow[]> {
    const jobs = await this.prismaService.job.findMany({
      where: {
        // `undefined` drops the clause entirely rather than matching a null column — the one Prisma
        // idiom where "no value" and "the value null" mean opposite things.
        projectId: args.projectId ?? undefined,
        archivedAt: args.archived ? { not: null } : null,
      },
      orderBy: { updatedAt: 'desc' },
      include: {
        project: { select: { name: true } },
        phases: {
          include: {
            threads: {
              include: {
                _count: { select: { messages: true } },
                // Newest message per thread, by ordinal: two messages of one turn can share a
                // millisecond, and the ordinal never ties.
                messages: { orderBy: { ordinal: 'desc' }, take: 1, select: { createdAt: true } },
              },
            },
          },
        },
      },
    });

    return jobs.map((job) => {
      const threads = job.phases.flatMap((p) => p.threads.map((t) => ({ thread: t, phase: p })));
      const active = threads.find((t) => t.thread.id === job.activeThreadId);
      const { phases: _phases, project, ...rest } = job;
      return {
        ...rest,
        activeRole: active?.thread.role ?? null,
        activePhase: active?.phase.kind ?? null,
        projectName: project.name,
        messageCount: threads.reduce((total, t) => total + t.thread._count.messages, 0),
        threads: threads.map(({ thread }) => ({
          id: thread.id,
          closed: thread.status === EThreadStatus.closed,
          lastMessageAt: thread.messages[0]?.createdAt ?? null,
          lastSeenAt: thread.lastSeenAt,
        })),
      };
    });
  }

  /**
   * Archive HIDES, it does not tear down: no filesystem is touched, no thread is closed, nothing is
   * reclaimed. That is what keeps restore lossless and leaves delete as the one destructive path.
   */
  async setArchived(args: { jobId: string; archived: boolean }): Promise<void> {
    await this.prismaService.job.update({
      where: { id: args.jobId },
      data: { archivedAt: args.archived ? new Date() : null },
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
      where: { phases: { some: { threads: { some: { id: { in: [...threadIds] } } } } } },
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
      where: { thread: { phase: { jobId } } },
      select: { engineSessionId: true },
    });
    return sessions
      .map((session) => session.engineSessionId)
      .filter((id): id is string => id !== null);
  }

  /** Phases, threads, sessions and messages all go with it, by `ON DELETE CASCADE`. */
  async remove(id: string): Promise<void> {
    await this.prismaService.job.delete({ where: { id } });
  }

  async findById(id: string): Promise<Job | null> {
    return this.prismaService.job.findUnique({ where: { id } });
  }

  /**
   * A job together with the repository it belongs to — what every worktree operation needs, since
   * `git worktree` is always run from the main worktree and the job only stores its own path.
   */
  async findWithProject(id: string): Promise<(Job & { project: Project }) | null> {
    return this.prismaService.job.findUnique({ where: { id }, include: { project: true } });
  }

  /**
   * The job took a branch and a worktree. Written by every door AND by the Atlas-owned worktree
   * tool as it moves — that write is precisely why the tool is allowed where Claude Code's native
   * worktree tool is not, since the native one relocates the work and leaves this field stale.
   */
  async setWorkspace(args: {
    jobId: string;
    branch: string;
    workspacePath: string;
  }): Promise<void> {
    await this.prismaService.job.update({
      where: { id: args.jobId },
      data: { branch: args.branch, workspacePath: args.workspacePath },
    });
  }

  /**
   * The worktree is gone; the job falls back to the project path. `branch` deliberately survives —
   * the branch is the work and may already carry a pull request, so it outlives its directory.
   */
  async clearWorkspace(jobId: string): Promise<void> {
    await this.prismaService.job.update({
      where: { id: jobId },
      data: { workspacePath: null },
    });
  }

  /**
   * A new job starts with one phase at ordinal 0 — the phase the caller names, which is always
   * `intake` today. Nothing here advances a phase; that is a confirmed transition, not a write.
   */
  async create(args: { projectId: string; title: string; kind: EPhaseKind }): Promise<Job> {
    return this.prismaService.job.create({
      data: {
        projectId: args.projectId,
        title: args.title,
        phases: { create: { kind: args.kind, ordinal: 0 } },
      },
    });
  }

  async setActiveThread(jobId: string, threadId: string): Promise<void> {
    await this.prismaService.job.update({
      where: { id: jobId },
      data: { activeThreadId: threadId },
    });
  }

  /**
   * Where a new thread lands. Phases are appended and never reopened, so the highest ordinal IS the
   * current phase — no lookup by kind, because the same kind can run twice on one job (a second
   * `direct_build` chasing a red build is a new phase, not the old one).
   *
   * A job is created with its first phase in the same statement, so having none is a broken
   * invariant rather than a case to paper over.
   */
  async currentPhase(jobId: string): Promise<Phase> {
    const phase = await this.prismaService.phase.findFirst({
      where: { jobId },
      orderBy: { ordinal: 'desc' },
    });
    if (!phase) throw new Error(`job ${jobId} has no phase`);
    return phase;
  }

  /**
   * The job's whole phase history, oldest first — what a brief is written against. A phase's
   * predecessor and whether its kind has run before are read off this list rather than stored on
   * the row: the list is append-only, so it already says both, and a denormalised copy could
   * disagree with it.
   */
  async listPhases(jobId: string): Promise<Phase[]> {
    return this.prismaService.phase.findMany({
      where: { jobId },
      orderBy: { ordinal: 'asc' },
    });
  }
}
