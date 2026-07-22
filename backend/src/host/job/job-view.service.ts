import { Injectable } from '@nestjs/common';
import type { JobListItem, ThreadGroupView, ThreadView } from '@workspace/shared';
import { Job } from '../../_lib/database/entities/job.entity';
import { ThreadGroup } from '../../_lib/database/entities/thread-group.entity';
import { Thread } from '../../_lib/database/entities/thread.entity';

@Injectable()
export class JobViewService {
  toJobListItem(job: Job): JobListItem {
    return {
      id: job.id,
      orgId: job.orgId,
      repoId: job.repoId,
      title: job.title,
      status: job.status,
      kind: job.kind,
      origin: job.origin,
      focusedThreadId: job.focusedThreadId,
      archivedAt: job.archivedAt ? job.archivedAt.toISOString() : null,
      createdAt: job.createdAt.toISOString(),
      updatedAt: job.updatedAt.toISOString(),
    };
  }

  toThreadView(thread: Thread): ThreadView {
    return {
      id: thread.id,
      jobId: thread.jobId,
      threadGroupId: thread.threadGroupId,
      role: thread.role,
      type: thread.type,
      parentThreadId: thread.parentThreadId,
      ordinal: thread.ordinal,
      brief: thread.brief,
      status: thread.status,
      condition: thread.condition,
      sessionId: thread.sessionId,
      createdAt: thread.createdAt.toISOString(),
      updatedAt: thread.updatedAt.toISOString(),
    };
  }

  toThreadGroupView(group: ThreadGroup, threads: Thread[]): ThreadGroupView {
    return {
      id: group.id,
      jobId: group.jobId,
      ordinal: group.ordinal,
      kind: group.kind,
      title: group.title,
      type: group.type,
      status: group.status,
      condition: group.condition,
      threads: threads.map((thread) => this.toThreadView(thread)),
    };
  }
}
