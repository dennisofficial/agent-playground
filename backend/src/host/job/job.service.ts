import { Injectable, NotFoundException } from '@nestjs/common';
import { Db, type RlsAction } from '@workspace/nestjs-rls/nest';
import type { JobListItem, JobView } from '@workspace/shared';
import { EJobStatus } from '@workspace/shared';
import { Job } from '../../_lib/database/entities/job.entity';
import { ThreadGroupRepo } from '../../_lib/database/entities/thread-group.entity';
import { Thread, ThreadRepo } from '../../_lib/database/entities/thread.entity';
import { InboundMessageService } from '../inbound-message/inbound-message.service';
import { SandboxService } from '../sandbox/sandbox.service';
import { JobViewService } from './job-view.service';

@Injectable()
export class JobService {
  constructor(
    private readonly db: Db,
    private readonly threadGroupRepo: ThreadGroupRepo,
    private readonly threadRepo: ThreadRepo,
    private readonly jobViewService: JobViewService,
    private readonly inbound: InboundMessageService,
    private readonly sandbox: SandboxService,
  ) {}

  /** The caller's jobs (newest first), optionally narrowed to one repo — the sidebar list. */
  async list(repoId?: string): Promise<JobListItem[]> {
    const rows = await this.db.scoped(Job).find({
      where: repoId ? { repoId } : {},
      order: { createdAt: 'DESC' },
    });
    return rows.map((j) => this.jobViewService.toJobListItem(j));
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
    // Archiving is terminal: drain the inbound queue so the reconciler can't resurrect the job, and tear the
    // sandbox down now rather than waiting on the idle reaper.
    await this.inbound.discardPending(jobId);
    await this.sandbox.teardown(jobId);
    // Build the result from the row we already hold + the applied change — a scoped RE-read would now
    // miss it (the read policy excludes archived jobs).
    return this.jobViewService.toJobListItem(
      Object.assign(job, { status: EJobStatus.ARCHIVED, archivedAt }),
    );
  }

  /** One job with its nested group→thread tree. */
  async get(jobId: string): Promise<JobView> {
    const job = await this.assertAccess(jobId);
    const [groups, threads] = await Promise.all([
      this.threadGroupRepo.find({ where: { jobId }, order: { ordinal: 'ASC' } }),
      this.threadRepo.find({ where: { jobId }, order: { ordinal: 'ASC' } }),
    ]);
    const threadsByGroup = new Map<string, Thread[]>();
    for (const t of threads) {
      const list = threadsByGroup.get(t.threadGroupId) ?? [];
      list.push(t);
      threadsByGroup.set(t.threadGroupId, list);
    }
    return {
      ...this.jobViewService.toJobListItem(job),
      threadGroups: groups.map((g) =>
        this.jobViewService.toThreadGroupView(g, threadsByGroup.get(g.id) ?? []),
      ),
    };
  }
}
