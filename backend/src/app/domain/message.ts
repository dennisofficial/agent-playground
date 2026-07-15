/**
 * The `Message` union — the canonical discriminated shape for EVERYTHING inbound to Atlas, retiring
 * the `Stimulus` vocabulary (see `./stimulus.ts`). `type` is the single source of truth for (a) DB
 * persistence/representation, (b) how a message frames into Claude Code (which XML chunk kind / notice
 * body), and (c) how the frontend renders it.
 *
 * DESIGNED WHOLE, WIRED IN STAGES (see `/context/specs/data-model.md`):
 *  - Job 1 wires the four client-originated variants (`UserMessage`, `AnswerQuestionMessage`,
 *    `FileAnsweredMessage`, `SecretProvidedMessage`) + the `eventKind` render discriminant on
 *    `EventMessage`, PLUS a transitional `SeedMessage` that carries every current internal-seed field
 *    verbatim so the brain (`agent-session-manager.service.ts`) stays untouched (strangler-fig seam).
 *  - Job 2 decomposes `SeedMessage` into the enumerated typed internal-seed variants, migrates the
 *    inbound `EventStimulus → EventMessage` union, and removes the carry-through fields.
 *
 * This file is additive alongside `./stimulus.ts` (`ChatStimulus`/`EventStimulus` stay the brain's
 * working currency in Job 1 — rewriting `agent-session-manager.service.ts` onto `Message` is Job 2's
 * blast radius, not this thread's).
 */

import type { ChunkKind } from '../stimulus/chunk-vocabulary';
import type { TurnChunk } from '../stimulus/chunk-vocabulary';
import type { EventSeverity, SeedRow } from './stimulus';

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

// ─── Client-originated variants (WIRED IN JOB 1) ──────────────────────────────────────────────────

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

/** Confirmation that a `request_secret` card's value was provided — the secret VALUE is written at
 *  intake, never in the union/row. */
export type SecretProvidedMessage = MessageBase & {
  type: 'secret_provided';
  trust: 'system';
  requestId: string;
  secretKind: 'durable' | 'mcp' | 'ephemeral';
};

// ─── Untrusted variant (inbound union WIRED IN JOB 2; render-type + eventKind WIRED IN JOB 1) ─────

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

/** A notification event — untrusted, dedupe-keyed, severity-tagged. The Job-2 inbound-union
 *  migration (dedupe/severity/correlation/routing onto this shape) is OUT of Job 1's scope; `eventKind`
 *  is introduced now as the render discriminant so Job 2's variant needs no rework. */
export type EventMessage = MessageBase & {
  type: 'event';
  trust: 'untrusted';
  /** The gateway id, e.g. 'github' | 'webhook' (NOT the event category). */
  source: string;
  eventKind: EventKind;
  dedupeKey: string;
  severity: EventSeverity;
  correlation?: { branch?: string; prNumber?: number };
  resumeThreadId?: string;
};

// ─── Transitional seam for Job 1 (strangler-fig) ───────────────────────────────────────────────────

/**
 * TRANSITIONAL: carries every current `ChatStimulus` internal-seed field verbatim, so Job 1 can
 * introduce the union WITHOUT rewriting the brain-side seed producers/consumers in
 * `agent-session-manager.service.ts`. Job 2 decomposes this into the enumerated typed internal-seed
 * variants (`reset_verify`, `compaction`, `ship_open_pr`, …) and removes this variant.
 *
 * NOTE: `seedHaltWake`/`seedDoneWake` are NOT carried — they were already removed upstream (dead
 * code; see decision d7) and must not be reintroduced.
 */
export type SeedMessage = MessageBase & {
  type: 'seed';
  trust: 'system';
  body: string;
  seedResetVerify?: boolean;
  resumeThreadId?: string;
  compact?: boolean;
  seedRow?: SeedRow;
  priority?: 'now' | 'queue' | 'later';
  chunks?: TurnChunk[];
  card?: Record<string, unknown>;
  /** Per-card delivery-stamp ids (composed-turn bookkeeping, generalizes answer-batch). */
  deliveredQuestionIds?: string[];
  deliveredFileIds?: string[];
  deliveredSecretIds?: string[];
};

/** The canonical inbound union. Every message carries `type` as its discriminant. */
export type Message =
  | UserMessage
  | AnswerQuestionMessage
  | FileAnsweredMessage
  | SecretProvidedMessage
  | EventMessage
  | SeedMessage;

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
 * answer/file/secret confirmation is a `system_notice`).
 */
export function messageChunkKind(type: MessageType): ChunkKind {
  switch (type) {
    case 'user':
      return 'user';
    case 'answer_question':
    case 'file_answered':
    case 'secret_provided':
      return 'system_notice';
    case 'event':
      return 'untrusted';
    case 'seed':
      return 'system_notice';
    default:
      return assertNever(type);
  }
}
