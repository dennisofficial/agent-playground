import type { JobListItem, ThreadGroupView, ThreadView } from '@workspace/shared';
import { Job } from '../../_lib/database/entities/job.entity';
import { ThreadGroup } from '../../_lib/database/entities/thread-group.entity';
import { Thread } from '../../_lib/database/entities/thread.entity';

export function toJobListItem(j: Job): JobListItem {
  return {
    id: j.id,
    orgId: j.orgId,
    repoId: j.repoId,
    title: j.title,
    status: j.status,
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
