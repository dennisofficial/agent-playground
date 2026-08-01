import { ScopedDb } from '@lib/pgbase/scoped-db';
import { Injectable, NotFoundException } from '@nestjs/common';
import type { JobListItem, JobView } from '@workspace/shared';
import { EJobStatus } from '@workspace/shared';
import type { JobModel, ThreadModel } from '../../generated/prisma/models';
import { InboundMessageService } from '../inbound-message/inbound-message.service';
import { SandboxService } from '../sandbox/sandbox.service';
import { JobViewService } from './job-view.service';

@Injectable()
export class JobService {
  constructor(
    private readonly scopedDb: ScopedDb,
    private readonly jobViewService: JobViewService,
    private readonly inbound: InboundMessageService,
    private readonly sandbox: SandboxService,
  ) {}

  /** The caller's jobs (newest first), optionally narrowed to one repo — the sidebar list. */
  async list(repoId?: string): Promise<JobListItem[]> {
    const rows = await this.scopedDb.job.findMany({
      where: repoId ? { repoId } : {},
      orderBy: { createdAt: 'desc' },
    });
    return rows.map((j) => this.jobViewService.toJobListItem(j));
  }

  async assertAccess(jobId: string): Promise<JobModel> {
    const job = await this.scopedDb.job.findUnique({ where: { id: jobId } });
    if (!job) throw new NotFoundException('Job not found');
    return job;
  }

  async archive(jobId: string): Promise<JobListItem> {
    const job = await this.assertAccess(jobId);
    const archivedAt = new Date();
    await this.scopedDb.job.update({
      where: { id: jobId },
      data: { status: EJobStatus.ARCHIVED, archivedAt },
    });
    // Archiving is terminal: drain the inbound queue so the reconciler can't resurrect the job, and tear the
    // sandbox down now rather than waiting on the idle reaper.
    await this.inbound.discardPending(jobId);
    await this.sandbox.teardown(jobId);
    // Build the result from the row we already hold + the applied change — a scoped RE-read would now
    // miss it (the read policy excludes archived jobs).
    return this.jobViewService.toJobListItem({
      ...job,
      status: EJobStatus.ARCHIVED,
      archivedAt,
    });
  }

  /** One job with its nested group→thread tree. */
  async get(jobId: string): Promise<JobView> {
    const job = await this.assertAccess(jobId);
    const [groups, threads] = await Promise.all([
      this.scopedDb.threadGroup.findMany({ where: { jobId }, orderBy: { ordinal: 'asc' } }),
      this.scopedDb.thread.findMany({ where: { jobId }, orderBy: { ordinal: 'asc' } }),
    ]);
    const threadsByGroup = new Map<string, ThreadModel[]>();
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
