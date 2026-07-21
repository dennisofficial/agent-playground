import { IsIn, IsNotEmpty, IsOptional, IsString, IsUUID } from 'class-validator';
import { EJobKind } from '../enums';
import type {
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
  kind: EJobKind | null;
  origin: EThreadOrigin;
  /** The thread a job click routes to by default, or null before any thread exists. */
  focusedThreadId: string | null;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * `POST /jobs` request — the class-validator DTO the backend validates and the web sends (one source of
 * truth). `kind` is restricted to the two operator-selectable kinds; the other create-modal controls
 * (base branch, automation, depends-on, attachments, review PR) are deferred, not part of the contract yet.
 */
export class CreateJobDto {
  @IsUUID()
  orgId!: string;

  @IsUUID()
  repoId!: string;

  @IsString()
  @IsNotEmpty()
  firstMessage!: string;

  @IsOptional()
  @IsString()
  title?: string;

  @IsOptional()
  @IsIn([EJobKind.FEATURE, EJobKind.BUGFIX])
  kind?: EJobKind.FEATURE | EJobKind.BUGFIX;
}

/** `POST /jobs` response — the new job's id and the thread the web redirects into. */
export interface CreateJobResult {
  jobId: string;
  focusedThreadId: string;
}

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

export interface JobView extends JobListItem {
  threadGroups: ThreadGroupView[];
}

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
