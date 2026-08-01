import {
  EAgentCredentialKind,
  EAgentCredentialStatus,
  EAgentProvider,
  EInboundMessageStatus,
  EInboundPriority,
  EJobKind,
  EJobStatus,
  EThreadCondition,
  EThreadGroupKind,
  EThreadMessageSource,
  EThreadOrigin,
  EThreadRole,
  EThreadStatus,
  EThreadType,
  ESubagentStatus,
  ETaskStatus,
  type AccountUsageSnapshot,
  type EThreadMessageType,
  type InboundMessagePayload,
  type InboundMessageView,
  type JobListItem,
  type JobView,
  type OrgSummary,
  type RawAgentCredential,
  type RepoView,
  type TaskView,
  type ThreadGroupView,
  type ThreadMessageView,
  type ThreadView,
} from '@workspace/shared';
import type { Models } from './client';

/**
 * Row → shared-DTO adapters for every pgbase live feed. `@workspace/shared`'s view types (`RepoView`,
 * `JobView`, …) predate pgbase and use nominal `E*` enums and ISO date STRINGS; pgbase rows carry real
 * `Date`s and the generator's own (structurally identical, but distinct) string-literal enum types. The
 * `as unknown as E*` casts below are exactly that representation gap — the string values already match,
 * TypeScript just can't see it across two independently-declared types.
 *
 * Downstream components keep consuming the shared DTOs unchanged; only this boundary layer knows the
 * wire actually comes from pgbase now (same pattern as `job-adapters.ts#threadMessageToJobMessage`).
 */

const iso = (d: Date): string => d.toISOString();
const isoOrNull = (d: Date | null): string | null => (d ? d.toISOString() : null);

export function repoToView(r: Models['Repo']): RepoView {
  return {
    id: r.id,
    orgId: r.orgId,
    slug: r.slug,
    name: r.name,
    gitUrl: r.gitUrl,
    defaultBranch: r.defaultBranch,
    accessOk: r.accessOk,
    accessCheckedAt: isoOrNull(r.accessCheckedAt),
    threadCount: r.threadCount,
    onboardingThreadId: r.onboardingThreadId,
    onboardedAt: isoOrNull(r.onboardedAt),
    webhookWarning: r.webhookWarning,
    branchPrefix: r.branchPrefix,
    defaultAutoMergeMethod: r.defaultAutoMergeMethod,
    defaultAutoMergeDeleteBranch: r.defaultAutoMergeDeleteBranch,
  };
}

export function agentCredentialToRaw(c: Models['AgentCredential']): RawAgentCredential {
  return {
    id: c.id,
    orgId: c.orgId,
    provider: c.provider as unknown as EAgentProvider,
    kind: c.kind as unknown as EAgentCredentialKind,
    label: c.label,
    accountEmail: c.accountEmail,
    subscriptionType: c.subscriptionType,
    status: c.status as unknown as EAgentCredentialStatus,
    selected: c.selected,
    expiresAt: c.expiresAt,
    usageSnapshot: c.usageSnapshot as AccountUsageSnapshot | null,
    createdAt: c.createdAt,
  };
}

export function orgSummaryOf(org: Models['Organization'], role: string): OrgSummary {
  return {
    id: org.id,
    name: org.name,
    status: org.status,
    role,
    defaultAutoApprove: org.defaultAutoApprove,
    defaultAutoShip: org.defaultAutoShip,
    defaultAutoMerge: org.defaultAutoMerge,
  };
}

export function jobToListItem(j: Models['Job']): JobListItem {
  return {
    id: j.id,
    orgId: j.orgId,
    repoId: j.repoId,
    title: j.title,
    status: j.status as unknown as EJobStatus,
    kind: j.kind as unknown as EJobKind | null,
    origin: j.origin as unknown as EThreadOrigin,
    focusedThreadId: j.focusedThreadId,
    archivedAt: isoOrNull(j.archivedAt),
    createdAt: iso(j.createdAt),
    updatedAt: iso(j.updatedAt),
  };
}

export function threadToView(t: Models['Thread']): ThreadView {
  return {
    id: t.id,
    jobId: t.jobId,
    threadGroupId: t.threadGroupId,
    role: t.role as unknown as EThreadRole,
    type: t.type as unknown as EThreadType,
    parentThreadId: t.parentThreadId,
    ordinal: t.ordinal,
    brief: t.brief,
    status: t.status as unknown as EThreadStatus,
    condition: t.condition as unknown as EThreadCondition,
    sessionId: t.sessionId,
    createdAt: iso(t.createdAt),
    updatedAt: iso(t.updatedAt),
  };
}

export function threadGroupToView(
  g: Models['ThreadGroup'],
  threads: readonly ThreadView[],
): ThreadGroupView {
  return {
    id: g.id,
    jobId: g.jobId,
    ordinal: g.ordinal,
    kind: g.kind as unknown as EThreadGroupKind,
    title: g.title,
    type: g.type,
    // ThreadGroupView reuses the thread-level EThreadStatus/EThreadCondition enums (there is no
    // separate EThreadGroupStatus/EThreadGroupCondition in @workspace/shared) — same string values.
    status: g.status as unknown as EThreadStatus,
    condition: g.condition as unknown as EThreadCondition,
    threads: [...threads],
  };
}

export function taskToView(t: Models['Task']): TaskView {
  return {
    id: t.id,
    jobId: t.jobId,
    threadGroupId: t.threadGroupId,
    ordinal: t.ordinal,
    title: t.title,
    brief: t.brief,
    activeForm: t.activeForm,
    status: t.status as unknown as ETaskStatus,
    blockedBy: (t.blockedBy as string[] | null) ?? [],
  };
}

export function inboundToView(m: Models['InboundMessage']): InboundMessageView {
  return {
    id: m.id,
    jobId: m.jobId,
    threadId: m.threadId,
    source: m.source as unknown as EThreadMessageSource,
    text: m.text,
    payload: m.payload as InboundMessagePayload | null,
    status: m.status as unknown as EInboundMessageStatus,
    priority: m.priority as unknown as EInboundPriority,
    createdAt: iso(m.createdAt),
  };
}

/**
 * `subagentStatus`/`subagentEndedAt` are NOT set here — they used to arrive already joined from
 * `Subagent`, and a live `ThreadMessage` subscription still can't join across tables. `Subagent` is
 * now client-readable (narrowly: `id`/`orgId`/`status`/`endedAt` only), so callers that need these two
 * fields compose a `ThreadMessage` feed with a `Subagent` feed themselves and layer them on with
 * {@link attachSubagentInfo} — see `lib/pgbase/thread-messages.ts`, used by `jobs.api.ts`'s
 * `getJobMessages`/`getThreadMessages`.
 */
export function threadMessageToView(m: Models['ThreadMessage']): ThreadMessageView {
  return {
    id: m.id,
    jobId: m.jobId,
    threadId: m.threadId,
    subagentId: m.subagentId,
    source: m.source as unknown as EThreadMessageSource,
    text: m.text,
    type: m.type as unknown as EThreadMessageType,
    card: m.card as Record<string, unknown> | null,
    meta: m.meta as Record<string, unknown> | null,
    orderAt: isoOrNull(m.orderAt),
    // The `postedAt` alias is gone on the wire — `ThreadMessage.createdAt` IS the posted-at time now.
    postedAt: iso(m.createdAt),
  };
}

/** Layers the two fields the old server-side join used to deliver onto an already-adapted message. */
export function attachSubagentInfo(
  view: ThreadMessageView,
  subagent: Models['Subagent'] | undefined,
): ThreadMessageView {
  if (!subagent) return view;
  return {
    ...view,
    subagentStatus: subagent.status as unknown as ESubagentStatus,
    subagentEndedAt: isoOrNull(subagent.endedAt),
  };
}

/**
 * The `job_detail` nested tree (`JobView.threadGroups[].threads`) used to be a server-composed view.
 * pgbase has no live joins, so this composes three own-column subscriptions (Job + ThreadGroup +
 * Thread, all filtered by `jobId`) client-side — the same pattern as the pgbase example app's
 * Task-joined-to-Job board (`examples/web/src/app/page.tsx`).
 */
export function buildJobView(
  job: Models['Job'],
  groups: readonly Models['ThreadGroup'][],
  threads: readonly Models['Thread'][],
): JobView {
  const threadViews = [...threads].sort((a, b) => a.ordinal - b.ordinal).map(threadToView);
  const threadGroups = [...groups]
    .sort((a, b) => a.ordinal - b.ordinal)
    .map((g) => threadGroupToView(g, threadViews.filter((t) => t.threadGroupId === g.id)));
  return { ...jobToListItem(job), threadGroups };
}
