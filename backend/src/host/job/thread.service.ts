import { Injectable } from '@nestjs/common';
import type { ThreadGroupView, ThreadView } from '@workspace/shared';
import type { FindOptionsWhere } from 'typeorm';
import { ThreadGroupRepo } from './entities/thread-group.entity';
import { Thread, ThreadRepo } from './entities/thread.entity';
import { toThreadGroupView, toThreadView } from './job.service';

@Injectable()
export class ThreadService {
  constructor(
    private readonly groups: ThreadGroupRepo,
    private readonly threads: ThreadRepo,
  ) {}

  /** The job's thread groups (ordered), each with its threads nested. */
  async listGroups(jobId: string): Promise<ThreadGroupView[]> {
    const [groups, threads] = await Promise.all([
      this.groups.find({ where: { jobId }, order: { ordinal: 'ASC' } }),
      this.threads.find({ where: { jobId }, order: { ordinal: 'ASC' } }),
    ]);
    const byGroup = new Map<string, Thread[]>();
    for (const t of threads) {
      const list = byGroup.get(t.threadGroupId) ?? [];
      list.push(t);
      byGroup.set(t.threadGroupId, list);
    }
    return groups.map((g) => toThreadGroupView(g, byGroup.get(g.id) ?? []));
  }

  /** The job's threads (ordered), optionally narrowed to one group or thread kind. */
  async listThreads(
    jobId: string,
    filter: { groupId?: string; kind?: string } = {},
  ): Promise<ThreadView[]> {
    const where: FindOptionsWhere<Thread> = { jobId };
    if (filter.groupId) where.threadGroupId = filter.groupId;
    if (filter.kind) where.type = filter.kind as Thread['type'];
    const rows = await this.threads.find({ where, order: { ordinal: 'ASC' } });
    return rows.map(toThreadView);
  }
}
