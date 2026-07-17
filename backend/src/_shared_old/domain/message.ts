import type { ChunkKind, TurnChunk } from '../stimulus/chunk-vocabulary';
import type { JobProvenance } from './job';
import type { EventSeverity, SeedRow } from './seed-row';

export type { ChunkKind };

export type MessageBase = {
  id: string;
  orgId: string;
  repoId: string;
  jobId: string;
  receivedAt: string;
};

export type MessageAttachment = {
  name: string;
  path: string;
  kind: 'image' | 'file';
  size: number;
};

export type UserMessage = MessageBase & {
  type: 'user';
  trust: 'trusted';
  body: string;
  author: { id: string; displayName: string };
  attachments?: MessageAttachment[];
  lane?: string;
};

export type AnswerQuestionMessage = MessageBase & {
  type: 'answer_question';
  trust: 'system';
  questionId: string;
  question: string;
  answer: string;
};

export type FileAnsweredMessage = MessageBase & {
  type: 'file_answered';
  trust: 'system';
  requestId: string;
  path: string;
  filename: string;
};

export type SecretProvidedMessage = MessageBase & {
  type: 'secret_provided';
  trust: 'system';
  requestId: string;
  secretKind: 'durable' | 'mcp' | 'ephemeral';
  name?: string;
  path?: string;
  mcp?: { server: string; slot: 'header' | 'env'; key: string };
  outcome?: 'delivered' | 'undelivered' | 'stored' | 'oauth_refused' | 'store_failed';
  reason?: string;
};

export type EventKind =
  | 'ci_failure'
  | 'review_changes_requested'
  | 'review_approved'
  | 'review_comment';

export type EventMessage = MessageBase & {
  type: 'event';
  trust: 'untrusted';
  body: string;
  source: string;
  eventKind: EventKind;
  dedupeKey: string;
  severity: EventSeverity;
  correlation?: { branch?: string; prNumber?: number };
  resumeThreadId?: string;
};

export type ResetVerifyMessage = MessageBase & {
  type: 'reset_verify';
  trust: 'system';
};

export type CompactionMessage = MessageBase & {
  type: 'compaction';
  trust: 'system';
};

export type WorkOwedNudgeMessage = MessageBase & {
  type: 'work_owed_nudge';
  trust: 'system';
  reviewId: string;
};

export type AmendApprovedMessage = MessageBase & {
  type: 'amend_approved_wake';
  trust: 'system';
};

export type ShipOpenPrMessage = MessageBase & {
  type: 'ship_open_pr';
  trust: 'system';
  branch: string;
  defaultBranch: string;
  title: string;
};

export type RequestChangesMessage = MessageBase & {
  type: 'request_changes';
  trust: 'system';
  note: string;
  decisionRecordId: string;
};

export type BlockerResolutionKind =
  | 'merged'
  | 'closed_unmerged'
  | 'cancelled'
  | 'deleted'
  | 'archived'
  | 'removed';

export type UnblockBlockerInfo = {
  jobId: string;
  title: string | null;
  how: BlockerResolutionKind;
};

export type UnblockedJobMessage = MessageBase & {
  type: 'unblocked_job_wake';
  trust: 'system';
  blockers: UnblockBlockerInfo[];
};

export type FollowUpJobSeedMessage = MessageBase & {
  type: 'follow_up_job_seed';
  trust: 'system';
  firstMessage: string;
  parent: JobProvenance | null;
};

export type RetryResumeMessage = MessageBase & {
  type: 'retry_resume_nudge';
  trust: 'system';
  title?: string;
};

export type SessionLimitResetMessage = MessageBase & {
  type: 'session_limit_reset_nudge';
  trust: 'system';
  title?: string;
};

export type McpApprovedMessage = MessageBase & {
  type: 'mcp_approved';
  trust: 'system';
  requestId: string;
  committed: string[];
  scope: 'org' | 'repo' | undefined;
  needSecrets: string[];
  needConnect: string[];
  readyStatic: number;
};

export type McpRemovedMessage = MessageBase & {
  type: 'mcp_removed';
  trust: 'system';
  requestId: string;
  removed: string[];
  scope: 'org' | 'repo' | undefined;
};

export type ConventionAttachedMessage = MessageBase & {
  type: 'convention_attached';
  trust: 'system';
  requestId: string;
  profileName: string;
};

export type ConventionEditedMessage = MessageBase & {
  type: 'convention_edited';
  trust: 'system';
  requestId: string;
  mode: string;
  name: string;
};

export type SkillApprovedMessage = MessageBase & {
  type: 'skill_approved';
  trust: 'system';
  requestId: string;
  mode: string;
  name: string;
  scope: string;
};

export type SkillEditApprovedMessage = MessageBase & {
  type: 'skill_edit_approved';
  trust: 'system';
  requestId: string;
  name: string;
  forkedTo?: string;
};

export type SkillEditGoneMessage = MessageBase & {
  type: 'skill_edit_gone';
  trust: 'system';
  requestId: string;
  name: string;
};

export type InternalSeedMessage =
  | ResetVerifyMessage
  | CompactionMessage
  | WorkOwedNudgeMessage
  | AmendApprovedMessage
  | ShipOpenPrMessage
  | RequestChangesMessage
  | UnblockedJobMessage
  | FollowUpJobSeedMessage
  | RetryResumeMessage
  | SessionLimitResetMessage
  | McpApprovedMessage
  | McpRemovedMessage
  | ConventionAttachedMessage
  | ConventionEditedMessage
  | SkillApprovedMessage
  | SkillEditApprovedMessage
  | SkillEditGoneMessage;

export type Message =
  | UserMessage
  | AnswerQuestionMessage
  | FileAnsweredMessage
  | SecretProvidedMessage
  | EventMessage
  | InternalSeedMessage;

export type MessageType = Message['type'];

export type TurnEnvelope = {
  message: Message;
  id: string;
  orgId: string;
  repoId: string;
  jobId: string;
  receivedAt: Date;
  author: { id: string; displayName: string };
  replyRoute: { surfaceId: string; jobRef: string };
  body: string;
  resumeThreadId?: string;
  seedRow?: SeedRow;
  chunks?: TurnChunk[];
  containsOperator?: boolean;
  cardBearingIds?: string[];
  priority?: 'now' | 'queue' | 'later';
  deliveredQuestionIds?: string[];
  deliveredFileIds?: string[];
  deliveredSecretIds?: string[];
  card?: Record<string, unknown>;
};

export function assertNever(value: never): never {
  throw new Error(`unhandled union member: ${JSON.stringify(value)}`);
}

export function messageChunkKind(type: MessageType): ChunkKind {
  switch (type) {
    case 'user':
      return 'user';
    case 'answer_question':
    case 'file_answered':
    case 'secret_provided':
    case 'reset_verify':
    case 'compaction':
    case 'work_owed_nudge':
    case 'amend_approved_wake':
    case 'ship_open_pr':
    case 'request_changes':
    case 'unblocked_job_wake':
    case 'follow_up_job_seed':
    case 'retry_resume_nudge':
    case 'session_limit_reset_nudge':
    case 'mcp_approved':
    case 'mcp_removed':
    case 'convention_attached':
    case 'convention_edited':
    case 'skill_approved':
    case 'skill_edit_approved':
    case 'skill_edit_gone':
      return 'system_notice';
    case 'event':
      return 'untrusted';
    default:
      return assertNever(type);
  }
}
