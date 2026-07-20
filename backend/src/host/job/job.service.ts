import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { type GuardAction, RealtimeEngine } from '@workspace/pg-realtime';
import { PG_REALTIME_ENGINE } from '@workspace/pg-realtime/nest';
import { scopedFindWhere } from '@workspace/pg-realtime/typeorm';
import type { JobListItem, JobView, ThreadGroupView, ThreadView } from '@workspace/shared';
import { Job, JobRepo } from './entities/job.entity';
import { ThreadGroup, ThreadGroupRepo } from './entities/thread-group.entity';
import { Thread, ThreadRepo } from './entities/thread.entity';

@Injectable()
export class JobService {
  constructor(
    private readonly jobs: JobRepo,
    private readonly groups: ThreadGroupRepo,
    private readonly threads: ThreadRepo,
    @Inject(PG_REALTIME_ENGINE) private readonly realtime: RealtimeEngine,
  ) {}

  /** The caller's jobs (newest first), optionally narrowed to one repo — the sidebar list. */
  async list(userId: string, repoId?: string): Promise<JobListItem[]> {
    const { allowed, where } = await scopedFindWhere<Job>({
      rls: this.realtime.rls,
      model: 'jobs',
      user: { id: userId },
      action: 'read',
      where: repoId ? { repoId } : {},
    });
    if (!allowed) return [];
    const rows = await this.jobs.find({ where, order: { createdAt: 'DESC' } });
    return rows.map((j) => toJobListItem(j));
  }

  async assertAccess(userId: string, jobId: string, action: GuardAction = 'read'): Promise<Job> {
    const { allowed, where } = await scopedFindWhere<Job>({
      rls: this.realtime.rls,
      model: 'jobs',
      user: { id: userId },
      action,
      where: { id: jobId },
    });
    const job = allowed ? await this.jobs.findOne({ where }) : null;
    if (!job) throw new NotFoundException('Job not found');
    return job;
  }

  /** One job with its nested group→thread tree. */
  async get(userId: string, jobId: string): Promise<JobView> {
    const job = await this.assertAccess(userId, jobId);
    const [groups, threads] = await Promise.all([
      this.groups.find({ where: { jobId }, order: { ordinal: 'ASC' } }),
      this.threads.find({ where: { jobId }, order: { ordinal: 'ASC' } }),
    ]);
    const threadsByGroup = new Map<string, Thread[]>();
    for (const t of threads) {
      const list = threadsByGroup.get(t.threadGroupId) ?? [];
      list.push(t);
      threadsByGroup.set(t.threadGroupId, list);
    }
    return {
      ...toJobListItem(job),
      threadGroups: groups.map((g) => toThreadGroupView(g, threadsByGroup.get(g.id) ?? [])),
    };
  }
}

export function toJobListItem(j: Job): JobListItem {
  return {
    id: j.id,
    orgId: j.orgId,
    repoId: j.repoId,
    title: j.title,
    status: j.status,
    activity: j.activity,
    kind: j.kind,
    origin: j.origin,
    focusedThreadId: j.focusedThreadId,
    archivedAt: j.archivedAt ? j.archivedAt.toISOString() : null,
    createdAt: j.createdAt.toISOString(),
    updatedAt: j.updatedAt.toISOString(),
  };
}

export function toThreadView(t: Thread): ThreadView {
  return {
    id: t.id,
    jobId: t.jobId,
    threadGroupId: t.threadGroupId,
    role: t.role,
    type: t.type,
    parentThreadId: t.parentThreadId,
    ordinal: t.ordinal,
    brief: t.brief,
    status: t.status,
    condition: t.condition,
    sessionId: t.sessionId,
    createdAt: t.createdAt.toISOString(),
    updatedAt: t.updatedAt.toISOString(),
  };
}

export function toThreadGroupView(g: ThreadGroup, threads: Thread[]): ThreadGroupView {
  return {
    id: g.id,
    jobId: g.jobId,
    ordinal: g.ordinal,
    kind: g.kind,
    title: g.title,
    type: g.type,
    status: g.status,
    condition: g.condition,
    threads: threads.map(toThreadView),
  };
}
