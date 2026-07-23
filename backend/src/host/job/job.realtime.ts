import type { ResolveClaims } from '@workspace/nestjs-rls';
import { rlsGuard } from '@workspace/nestjs-rls/pg-realtime';
import type { ModelConfig, Row } from '@workspace/pg-realtime';
import { InboundMessage } from '../../_lib/database/entities/inbound-message.entity';
import { Job } from '../../_lib/database/entities/job.entity';
import { Task } from '../../_lib/database/entities/task.entity';
import { ThreadGroup } from '../../_lib/database/entities/thread-group.entity';
import { ThreadMessage } from '../../_lib/database/entities/thread-message.entity';
import { Thread } from '../../_lib/database/entities/thread.entity';

export function buildJobRealtimeModels(resolveClaims: ResolveClaims): ModelConfig[] {
  return [
    {
      table: 'jobs',
      name: 'jobs',
      primaryKey: 'id',
      guard: rlsGuard(Job, resolveClaims),
      mapRow: (raw: Row): Row => ({
        id: raw.id,
        orgId: raw.org_id, // kept for the guard scope
        repoId: raw.repo_id,
        title: raw.title,
        status: raw.status,
        kind: raw.kind,
        origin: raw.origin,
        focusedThreadId: raw.focused_thread_id,
        archivedAt: raw.archived_at,
        createdAt: raw.created_at,
        updatedAt: raw.updated_at,
      }),
    },
    {
      table: 'thread_groups',
      name: 'thread_groups',
      primaryKey: 'id',
      guard: rlsGuard(ThreadGroup, resolveClaims),
      mapRow: (raw: Row): Row => ({
        id: raw.id,
        orgId: raw.org_id,
        jobId: raw.job_id,
        ordinal: raw.ordinal,
        kind: raw.kind,
        title: raw.title,
        type: raw.type,
        status: raw.status,
        condition: raw.condition,
      }),
    },
    {
      table: 'threads',
      name: 'threads',
      primaryKey: 'id',
      guard: rlsGuard(Thread, resolveClaims),
      mapRow: (raw: Row): Row => ({
        id: raw.id,
        orgId: raw.org_id,
        jobId: raw.job_id,
        threadGroupId: raw.thread_group_id,
        role: raw.role,
        type: raw.type,
        parentThreadId: raw.parent_thread_id,
        ordinal: raw.ordinal,
        brief: raw.brief,
        status: raw.status,
        condition: raw.condition,
        sessionId: raw.session_id,
        createdAt: raw.created_at,
        updatedAt: raw.updated_at,
      }),
    },
    {
      table: 'thread_messages',
      name: 'thread_messages',
      primaryKey: 'id',
      guard: rlsGuard(ThreadMessage, resolveClaims),
      mapRow: (raw: Row): Row => ({
        id: raw.id,
        orgId: raw.org_id,
        jobId: raw.job_id,
        threadId: raw.thread_id,
        subagentId: raw.subagent_id,
        source: raw.source,
        isAtlas: raw.source === 'atlas',
        authorId: raw.author_id,
        text: raw.text,
        kind: raw.kind,
        card: raw.card,
        meta: raw.meta,
        orderAt: raw.order_at,
        postedAt: raw.created_at,
      }),
    },
    {
      // The "sent, not yet consumed" queue — the composer's pending zone streams PENDING rows and drops each
      // when it flips to CONSUMED (at which point a thread_messages bubble takes its place).
      table: 'inbound_messages',
      name: 'inbound_messages',
      primaryKey: 'id',
      guard: rlsGuard(InboundMessage, resolveClaims),
      mapRow: (raw: Row): Row => ({
        id: raw.id,
        orgId: raw.org_id,
        jobId: raw.job_id,
        threadId: raw.thread_id,
        source: raw.source,
        authorId: raw.author_id,
        text: raw.text,
        payload: raw.payload,
        status: raw.status,
        priority: raw.priority,
        createdAt: raw.created_at,
      }),
    },
    {
      table: 'tasks',
      name: 'tasks',
      primaryKey: 'id',
      guard: rlsGuard(Task, resolveClaims),
      mapRow: (raw: Row): Row => ({
        id: raw.id,
        orgId: raw.org_id,
        jobId: raw.job_id,
        threadGroupId: raw.thread_group_id,
        ordinal: raw.ordinal,
        title: raw.title,
        brief: raw.brief,
        activeForm: raw.active_form,
        status: raw.status,
        blockedBy: raw.blocked_by,
      }),
    },
  ];
}
