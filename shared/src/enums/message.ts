export enum EInboundMessageType {
  /** A plain operator chat message. */
  OPERATOR = 'operator',
  /** An operator's answer to a `QUESTION` card. */
  ANSWER_QUESTION = 'answer_question',
  /** An operator's file upload answering a `FILE_REQUEST` card. */
  FILE_ANSWERED = 'file_answered',
  /** An operator providing a secret answering a `SECRET_REQUEST` card (the value is never persisted). */
  SECRET_PROVIDED = 'secret_provided',
  /** A sent inline-review-comment batch (composer). */
  REVIEW_COMMENTS = 'review_comments',
  /** Files/images the operator attached in the composer. */
  ATTACHMENTS = 'attachments',
}

/** Types that only ever appear as thread OUTPUT — never sent in via intake. */
export enum EThreadOutputType {
  /** Atlas assistant prose. */
  CHAT = 'chat',
  /** Atlas extended-thinking block. */
  THINKING = 'thinking',
  /** A tool call + its result. */
  TOOL = 'tool',
  /** An approval request card (plan/ship gate). */
  APPROVAL = 'approval',
  /** A verdict card (approve/deny outcome). */
  VERDICT = 'verdict',
  /** A question card Atlas raised (answered via `ANSWER_QUESTION`). */
  QUESTION = 'question',
  /** A secret-input request card (answered via `SECRET_PROVIDED`). */
  SECRET_REQUEST = 'secret_request',
  /** A file-upload request card (answered via `FILE_ANSWERED`). */
  FILE_REQUEST = 'file_request',
  /** A stack-matched MCP-server recommendation card. */
  MCP_PROPOSAL = 'mcp_proposal',
  /** A skill-install/authoring proposal card. */
  SKILL_PROPOSAL = 'skill_proposal',
  /** A sandbox/build lifecycle pill. */
  EVENT = 'event',
  /** A session-compaction pill carrying the handoff summary. */
  COMPACTION = 'compaction',
  /** Untrusted external data folded into a turn. */
  UNTRUSTED = 'untrusted',
  /** System→operator+Atlas shared block (e.g. Codex plan-review findings). */
  SYSTEM_SHARED = 'system_shared',
  /** An automated notification that opened the thread (a harness delivery to Atlas). */
  SYSTEM_EVENT = 'system_event',
  /** System→operator-only notice (e.g. an unresumable-thread error). */
  SYSTEM_OPERATOR = 'system_operator',
  /** A harness-injected state-change pill (sandbox reset, secret/file confirmation). */
  SYSTEM_NOTICE = 'system_notice',
  /** Harness context that rode alongside a turn (pipeline awareness, open questions). */
  SYSTEM_REMINDER = 'system_reminder',
  /** A build-thread anchor row — driver bookkeeping, not operator-facing (never rendered). */
  BUILD_ANCHOR = 'build_anchor',
}

/** Every type a `thread_messages` row can carry — intake types PLUS output-only types. THE authoritative set. */
export type EThreadMessageType = EInboundMessageType | EThreadOutputType;

/** Runtime list of all {@link EThreadMessageType} values — for the DB enum column and wire validation.
 *  Derived from both enums so there is exactly ONE place each type is declared. */
export const THREAD_MESSAGE_TYPE_VALUES: readonly EThreadMessageType[] = [
  ...Object.values(EInboundMessageType),
  ...Object.values(EThreadOutputType),
];

export enum EThreadMessageSource {
  OPERATOR = 'operator',
  ATLAS = 'atlas',
  SYSTEM = 'system', // harness-authored (notices, events, reminders, injected context) — Atlas didn't write it
  UNTRUSTED = 'untrusted', // content from an untrusted external source, folded into a turn
}

export enum EMessageAudience {
  OPERATOR_ONLY = 'operator_only', // rendered to the operator; never enters Atlas's context
  SHARED = 'shared', // rendered to the operator AND part of Atlas's context
}
