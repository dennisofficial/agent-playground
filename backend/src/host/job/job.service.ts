import { Injectable, NotFoundException } from '@nestjs/common';
import { Db, type RlsAction } from '@workspace/nestjs-rls/nest';
import type { JobListItem, JobView, ThreadGroupView, ThreadView } from '@workspace/shared';
import { Job } from '../../_lib/database/entities/job.entity';
import { ThreadGroup, ThreadGroupRepo } from '../../_lib/database/entities/thread-group.entity';
import { Thread, ThreadRepo } from '../../_lib/database/entities/thread.entity';

@Injectable()
export class JobService {
  constructor(
    private readonly db: Db,
    private readonly groups: ThreadGroupRepo,
    private readonly threads: ThreadRepo,
  ) {}

  /** The caller's jobs (newest first), optionally narrowed to one repo — the sidebar list. */
  async list(repoId?: string): Promise<JobListItem[]> {
    const rows = await this.db.scoped(Job).find({
      where: repoId ? { repoId } : {},
      order: { createdAt: 'DESC' },
    });
    return rows.map((j) => toJobListItem(j));
  }

  async assertAccess(jobId: string, action: RlsAction = 'read'): Promise<Job> {
    const job = await this.db.scoped(Job).findOneScoped({ id: jobId }, action);
    if (!job) throw new NotFoundException('Job not found');
    return job;
  }

  /** One job with its nested group→thread tree. */
  async get(jobId: string): Promise<JobView> {
    const job = await this.assertAccess(jobId);
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
