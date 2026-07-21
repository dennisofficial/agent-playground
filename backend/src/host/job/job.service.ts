import { Injectable, NotFoundException } from '@nestjs/common';
import { Db, type RlsAction } from '@workspace/nestjs-rls/nest';
import type { JobListItem, JobView } from '@workspace/shared';
import { EJobStatus } from '@workspace/shared';
import { Job } from '../../_lib/database/entities/job.entity';
import { ThreadGroupRepo } from '../../_lib/database/entities/thread-group.entity';
import { Thread, ThreadRepo } from '../../_lib/database/entities/thread.entity';
import { toJobListItem, toThreadGroupView } from './job.view';

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

  async archive(jobId: string): Promise<JobListItem> {
    const job = await this.assertAccess(jobId, 'update');
    const archivedAt = new Date();
    await this.db.scoped(Job).update({ id: jobId }, { status: EJobStatus.ARCHIVED, archivedAt });
    // Build the result from the row we already hold + the applied change — a scoped RE-read would now
    // miss it (the read policy excludes archived jobs).
    return toJobListItem(Object.assign(job, { status: EJobStatus.ARCHIVED, archivedAt }));
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
