import type {
  EJobActivity,
  EJobKind,
  EJobStatus,
  ESubagentStatus,
  ETaskStatus,
  EThreadCondition,
  EThreadGroupKind,
  EThreadMessageKind,
  EThreadMessageSource,
  EThreadOrigin,
  EThreadRole,
  EThreadStatus,
  EThreadType,
} from '../enums';

export interface JobListItem {
  id: string;
  orgId: string;
  repoId: string;
  title: string | null;
  status: EJobStatus;
  activity: EJobActivity;
  kind: EJobKind | null;
  origin: EThreadOrigin;
  /** The thread a job click routes to by default, or null before any thread exists. */
  focusedThreadId: string | null;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/** One thread (execution lane) within a group. */
export interface ThreadView {
  id: string;
  jobId: string;
  threadGroupId: string;
  role: EThreadRole;
  type: EThreadType;
  /** The parent lane this one nests under (review children), or null for a top-level lane. */
  parentThreadId: string | null;
  ordinal: number;
  brief: string;
  status: EThreadStatus;
  condition: EThreadCondition;
  sessionId: string | null;
  createdAt: string;
  updatedAt: string;
}

/** One thread group (pipeline phase / navigator item), with its threads nested for the workspace. */
export interface ThreadGroupView {
  id: string;
  jobId: string;
  ordinal: number;
  kind: EThreadGroupKind;
  title: string | null;
  type: string | null;
  status: EThreadStatus;
  condition: EThreadCondition;
  threads: ThreadView[];
}

/** The full job detail (`GET /jobs/:jobId`) — the list item plus the nested group→thread tree the
 *  workspace navigator renders. Transcript messages are fetched per-thread, not embedded. */
export interface JobView extends JobListItem {
  threadGroups: ThreadGroupView[];
}

/** One durable transcript block (`GET /jobs/:jobId/threads/:threadId/messages`) — the wire shape the web
 *  conversation renders (mirrors the client's `RawThreadMessage`). `isAtlas` derives from `source`;
 *  `subagentStatus`/`subagentEndedAt` are joined from the subagent row on the anchor (Task) message. */
export interface ThreadMessageView {
  id: string;
  jobId: string;
  threadId: string;
  subagentId: string | null;
  subagentStatus?: ESubagentStatus | null;
  subagentEndedAt?: string | null;
  source: EThreadMessageSource;
  isAtlas: boolean;
  authorId: string;
  /** Display name of the author. */
  author: string;
  text: string;
  kind: EThreadMessageKind;
  card: Record<string, unknown> | null;
  meta: Record<string, unknown> | null;
  /** Render-order override (`order_at`), or null → falls back to `postedAt`. */
  orderAt: string | null;
  /** ISO time the row was created (serves as the message's posted-at). */
  postedAt: string;
}

/** One spawned subagent (Task tool run) with its token/cost accounting. */
export interface SubagentView {
  id: string;
  threadId: string;
  parentMessageId: string;
  toolUseId: string;
  agentType: string | null;
  model: string | null;
  status: ESubagentStatus;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd: number | null;
  startedAt: string | null;
  endedAt: string | null;
}

/** One item in a thread group's agent TODO list (`GET /jobs/:jobId/tasks`). */
export interface TaskView {
  id: string;
  jobId: string;
  threadGroupId: string;
  ordinal: number;
  title: string;
  brief: string | null;
  activeForm: string | null;
  status: ETaskStatus;
  /** Ids of tasks that must complete before this one (dependency edges). */
  blockedBy: string[];
}
