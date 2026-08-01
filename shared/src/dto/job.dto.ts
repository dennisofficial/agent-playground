import {
  ArrayNotEmpty,
  IsArray,
  IsIn,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
} from 'class-validator';
import type {
  EInboundMessageStatus,
  EInboundPriority,
  EJobStatus,
  ESubagentStatus,
  ETaskStatus,
  EThreadCondition,
  EThreadGroupKind,
  EThreadMessageSource,
  EThreadMessageType,
  EThreadOrigin,
  EThreadRole,
  EThreadStatus,
  EThreadType,
} from '../enums';
import { EJobKind } from '../enums';

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

export interface CreateJobResult {
  jobId: string;
  focusedThreadId: string;
}

export type InboundItemInput =
  | { type: 'operator'; text: string }
  | { type: 'answer_question'; questionId: string; answer: string }
  | { type: 'file_answered'; requestId: string; filename: string; content: string }
  | { type: 'secret_provided'; requestId: string; value: string };

export type InboundMessagePayload =
  | { type: 'operator' }
  | { type: 'answer_question'; questionId: string }
  | { type: 'file_answered'; requestId: string; filename: string; content: string }
  | { type: 'secret_provided'; requestId: string };

/** `POST /jobs/:jobId/messages` request — a typed batch (NOT flattened text). `threadId` defaults to focus. */
export class SendMessageDto {
  // NOTE: items pass through un-whitelisted (no @ValidateNested yet) — deep per-item validation is a follow-up.
  @IsArray()
  @ArrayNotEmpty()
  messages!: InboundItemInput[];

  @IsOptional()
  @IsUUID()
  threadId?: string;
}

/** `POST /jobs/:jobId/messages` response — the enqueued inbound rows, in send order. */
export interface SendMessageResult {
  messageIds: string[];
}

export interface InboundMessageView {
  id: string;
  jobId: string;
  threadId: string;
  source: EThreadMessageSource;
  text: string;
  payload: InboundMessagePayload | null;
  status: EInboundMessageStatus;
  priority: EInboundPriority;
  createdAt: string;
}

export type LiveTurnFrame =
  | { kind: 'turn_start'; turnId: string; threadId: string; startedAt: number }
  /** `emittedAt` is the SERVER instant the engine wrote this event (the Redis stream entry's own ms id), so a
   *  live block's render order is comparable to a durable row's `orderAt`/`postedAt` — both server-clock. It
   *  survives replay: a late subscriber re-reads the same entry ids and rebuilds the same order. */
  | { kind: 'event'; turnId: string; event: unknown; emittedAt: number }
  | { kind: 'turn_end'; turnId: string };

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
  text: string;
  type: EThreadMessageType;
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
