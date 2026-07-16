/**
 * The `Message` union — the canonical discriminated shape for EVERYTHING inbound to Atlas, retiring
 * the `Stimulus` vocabulary (see `./stimulus.ts`). `type` is the single source of truth for (a) DB
 * persistence/representation, (b) how a message frames into Claude Code (which XML chunk kind / notice
 * body), and (c) how the frontend renders it.
 *
 * DESIGNED WHOLE, WIRED IN STAGES (see `/context/specs/data-model.md`):
 *  - Job 1 wired the four client-originated variants (`UserMessage`, `AnswerQuestionMessage`,
 *    `FileAnsweredMessage`, `SecretProvidedMessage`) + the `eventKind` render discriminant on
 *    `EventMessage`, behind a transitional `SeedMessage` catch-all that carried every internal-seed
 *    field verbatim so the brain stayed untouched (strangler-fig seam).
 *  - Job 2 (this file's current state) decomposed `SeedMessage` into the enumerated typed internal-seed
 *    variants (`InternalSeedMessage`), enriched `SecretProvidedMessage` with the server-confirmation
 *    sub-cases, and gave `EventMessage` its own `body`. The ONE centralized renderer is
 *    `prompt-kit/harness/compose-message.ts` (`composeMessageBody`), whose exhaustive switch turns each
 *    variant into its `AgentMessage` body + optional `SeedRow`.
 */

import type { ChunkKind } from '../stimulus/chunk-vocabulary';
import type { EventSeverity } from './stimulus';
import type { JobProvenance } from './job';

export type { ChunkKind };

/** Fields every `Message` variant carries. */
export type MessageBase = {
  /** Stable id minted at intake (the `inbound_messages` PK once persisted). */
  id: string;
  orgId: string;
  repoId: string;
  /** The thread this message belongs to. */
  jobId: string;
  /** ISO receipt timestamp. */
  receivedAt: string;
};

/** One composer attachment (mirrors `AttachmentCardItem`, `prompt-kit/messages/first-turn-seeds.ts`) —
 *  replaces `ChatStimulus.card`'s ad-hoc `attachments_card` path for a `UserMessage`. */
export type MessageAttachment = {
  /** The operator's (sanitized) filename, for display. */
  name: string;
  /** Bucket-relative path under `/context` (`uploads/<safeName>`). */
  path: string;
  kind: 'image' | 'file';
  size: number;
};

// ─── Client-originated variants ───────────────────────────────────────────────────────────────────

/** A free-text operator chat message — trusted, rendered `<user>`. */
export type UserMessage = MessageBase & {
  type: 'user';
  trust: 'trusted';
  body: string;
  author: { id: string; displayName: string };
  attachments?: MessageAttachment[];
  /** Routing coordinate: `'main'` (planning brain) | `'thread:<id>'` (a build lane). */
  lane?: string;
};

/** An operator's answer to an `ask_question` card — system-authored context, not a chat bubble. */
export type AnswerQuestionMessage = MessageBase & {
  type: 'answer_question';
  trust: 'system';
  questionId: string;
  /** The original question text (for the notice body). */
  question: string;
  answer: string;
};

/** Confirmation that a `request_file` card's uploaded file landed — the file CONTENT is written to
 *  the encrypted secret store at intake, never carried in the union or persisted in the intake row. */
export type FileAnsweredMessage = MessageBase & {
  type: 'file_answered';
  trust: 'system';
  requestId: string;
  path: string;
  filename: string;
};

/**
 * Confirmation that a `request_secret` card's value was provided — the secret VALUE is written at
 * intake, never in the union/row. Carries the SERVER-INITIATED provide-secret confirmation sub-case
 * (`outcome`) so the compose switch renders the right body (secretStored / secretEphemeralDelivered /
 * secretEphemeralUndelivered / mcpSecretStored / mcpSecretOauthRefused / mcpSecretStoreFailed) and the
 * right chunkKey. A plain operator-supplied provide (no `outcome`) renders the generic notice.
 */
export type SecretProvidedMessage = MessageBase & {
  type: 'secret_provided';
  trust: 'system';
  requestId: string;
  secretKind: 'durable' | 'mcp' | 'ephemeral';
  /** For the masked/stored confirmation body. */
  name?: string;
  path?: string;
  /** mcp-target confirmation. */
  mcp?: { server: string; slot: 'header' | 'env'; key: string };
  outcome?: 'delivered' | 'undelivered' | 'stored' | 'oauth_refused' | 'store_failed';
  /** ephemeral-undelivered reason. */
  reason?: string;
};

// ─── Untrusted variant ────────────────────────────────────────────────────────────────────────────

/**
 * The render-time subtype of an inbound GitHub/webhook event, derived from the raw event
 * type/action/conclusion in `summarizeGithubEvent` (previously discarded after picking severity).
 * Drives per-kind frontend rendering (`EventBubble`, thread 3) via `meta.eventKind` on the event
 * transcript row.
 */
export type EventKind =
  | 'ci_failure'
  | 'review_changes_requested'
  | 'review_approved'
  | 'review_comment';

/** A notification event — untrusted, dedupe-keyed, severity-tagged. `body` is the raw event text,
 *  fenced `<untrusted>` at the delivery seam (`renderEventDelivery`). `correlation` is transient —
 *  consumed at routing, never persisted. */
export type EventMessage = MessageBase & {
  type: 'event';
  trust: 'untrusted';
  /** The raw event text, fenced `<untrusted>` at delivery. */
  body: string;
  /** The gateway id, e.g. 'github' | 'webhook' (NOT the event category). */
  source: string;
  eventKind: EventKind;
  dedupeKey: string;
  severity: EventSeverity;
  correlation?: { branch?: string; prNumber?: number };
  resumeThreadId?: string;
};

// ─── Internal-seed variants (host-authored system turns) ────────────────────────────────────────────
// Each carries every input its `seed-catalog` builder needs AND every id its compose-switch chunkKey/label
// references, so `composeMessageBody` can reproduce today's body AND chunkKey byte-for-byte. `jobId`/`orgId`/
// `repoId` ride on `MessageBase`; the OTHER ids are declared explicitly.

/** A no-op wake after a sandbox reset — guarded-consumed on the first cold-attaching turn. */
export type ResetVerifyMessage = MessageBase & {
  type: 'reset_verify';
  trust: 'system';
};

/** Triggers the summarization (compaction) turn — its own brain-side special-casing, not a plain notice. */
export type CompactionMessage = MessageBase & {
  type: 'compaction';
  trust: 'system';
};

/** Nudge to resume an interrupted `review_plan`. */
export type WorkOwedNudgeMessage = MessageBase & {
  type: 'work_owed_nudge';
  trust: 'system';
  reviewId: string;
};

/** Wake after the operator approved an amend proposal. */
export type AmendApprovedMessage = MessageBase & {
  type: 'amend_approved_wake';
  trust: 'system';
};

/** The ship-time open-PR turn body — `shipOpenPrBody` needs all three fields. */
export type ShipOpenPrMessage = MessageBase & {
  type: 'ship_open_pr';
  trust: 'system';
  branch: string;
  defaultBranch: string;
  title: string;
};

/** Delivery of an operator's request-changes note into the resumed planning session. */
export type RequestChangesMessage = MessageBase & {
  type: 'request_changes';
  trust: 'system';
  note: string;
  decisionRecordId: string;
};

/** Wake once every blocking job resolved (the job already had a session). */
export type UnblockedJobMessage = MessageBase & {
  type: 'unblocked_job_wake';
  trust: 'system';
  note: string | null;
};

/** Seed framing for a follow-up thread spawned by ANOTHER Atlas job via `create_job`. */
export type FollowUpJobSeedMessage = MessageBase & {
  type: 'follow_up_job_seed';
  trust: 'system';
  firstMessage: string;
  parent: JobProvenance | null;
};

/** The `/retry-turn` resume nudge. */
export type RetryResumeMessage = MessageBase & {
  type: 'retry_resume_nudge';
  trust: 'system';
  title?: string;
};

/** The auto-resume nudge after a session-limit reset. */
export type SessionLimitResetMessage = MessageBase & {
  type: 'session_limit_reset_nudge';
  trust: 'system';
  title?: string;
};

// Approval confirmations (constructed in web-surface.controller approve handlers). Each carries the builder
// args PLUS the requestId its chunkKey uses.

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

/** The union of every host-authored internal-seed variant. `messageChunkKind` returns `system_notice`
 *  for all of them; `composeMessageBody` owns their body + `SeedRow`. */
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

/** The canonical inbound union. Every message carries `type` as its discriminant. */
export type Message =
  | UserMessage
  | AnswerQuestionMessage
  | FileAnsweredMessage
  | SecretProvidedMessage
  | EventMessage
  | InternalSeedMessage;

/** The message-type discriminant, standalone (for column/param types that don't need the full union). */
export type MessageType = Message['type'];

/**
 * Exhaustiveness helper — call in the `default`/`else` arm of a switch over `Message`/`MessageType` (or
 * any closed union). TypeScript narrows the switched value to `never` once every case is handled, so a
 * new variant without a matching arm fails the BUILD here instead of silently falling through.
 */
export function assertNever(value: never): never {
  throw new Error(`unhandled union member: ${JSON.stringify(value)}`);
}

/**
 * The chunk kind a `Message` type frames into (`tag-vocabulary.ts`'s vocabulary) — the low-level
 * render layer the Message union sits on top of. Many message types share one chunk kind (every
 * answer/file/secret confirmation and every internal seed is a `system_notice`).
 */
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
