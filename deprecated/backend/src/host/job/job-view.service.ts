import { Injectable } from '@nestjs/common';
import type {
  EJobKind,
  EJobStatus,
  EThreadCondition,
  EThreadGroupKind,
  EThreadOrigin,
  EThreadRole,
  EThreadStatus,
  EThreadType,
  JobListItem,
  ThreadGroupView,
  ThreadView,
} from '@workspace/shared';
import type { JobModel, ThreadGroupModel, ThreadModel } from '../../generated/prisma/models';

@Injectable()
export class JobViewService {
  toJobListItem(job: JobModel): JobListItem {
    return {
      id: job.id,
      orgId: job.orgId,
      repoId: job.repoId,
      title: job.title,
      status: job.status as unknown as EJobStatus,
      kind: job.kind as unknown as EJobKind | null,
      origin: job.origin as unknown as EThreadOrigin,
      focusedThreadId: job.focusedThreadId,
      archivedAt: job.archivedAt ? job.archivedAt.toISOString() : null,
      createdAt: job.createdAt.toISOString(),
      updatedAt: job.updatedAt.toISOString(),
    };
  }

  toThreadView(thread: ThreadModel): ThreadView {
    return {
      id: thread.id,
      jobId: thread.jobId,
      threadGroupId: thread.threadGroupId,
      role: thread.role as unknown as EThreadRole,
      type: thread.type as unknown as EThreadType,
      parentThreadId: thread.parentThreadId,
      ordinal: thread.ordinal,
      brief: thread.brief,
      status: thread.status as unknown as EThreadStatus,
      condition: thread.condition as unknown as EThreadCondition,
      sessionId: thread.sessionId,
      createdAt: thread.createdAt.toISOString(),
      updatedAt: thread.updatedAt.toISOString(),
    };
  }

  toThreadGroupView(group: ThreadGroupModel, threads: ThreadModel[]): ThreadGroupView {
    return {
      id: group.id,
      jobId: group.jobId,
      ordinal: group.ordinal,
      kind: group.kind as unknown as EThreadGroupKind,
      title: group.title,
      type: group.type,
      status: group.status as unknown as EThreadStatus,
      condition: group.condition as unknown as EThreadCondition,
      threads: threads.map((thread) => this.toThreadView(thread)),
    };
  }
}
