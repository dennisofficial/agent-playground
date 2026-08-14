import { EMessageType } from '../generated/prisma/enums.js';
import type { DelegateEvent } from './delegate-events.js';
import { renderAttachmentParts, type AttachmentPart } from './attachments.js';
import { stripTerminalControls } from './plain-text.js';
import type { DiffHunk } from './tool-diff.js';

// Re-exported for the same reason `tool-view.ts` re-exports `tool-shape.ts`: which half of a pair a
// name lives in is not the caller's business, and every consumer of `EngineEvent` that touches a
// delegate wants `EDelegateStatus` in the same breath.
export {
  EDelegateStatus,
  type BackgroundTaskRef,
  type DelegateEvent,
  type DelegateOutcome,
} from './delegate-events.js';

export type UserPayload = {
  type: typeof EMessageType.user;
  text: string;
};

export type AssistantPayload = {
  type: typeof EMessageType.assistant;
  text: string;
  /** Set when the block was cut short by an interrupt — renders without a trailing caret. */
  interrupted?: boolean;
};

export type ThinkingPayload = {
  type: typeof EMessageType.thinking;
  text: string;
};

export type ToolCallPayload = {
  type: typeof EMessageType.tool_call;
  toolUseId: string;
  name: string;
  target?: string;
  input: unknown;
};

export type ToolResultPayload = {
  type: typeof EMessageType.tool_result;
  toolUseId: string;
  ok: boolean;
  summary: string;
  detail: string[];
  /**
   * The hunks a file-editing tool produced, stored rather than re-derived: the patch exists only in
   * the live SDK frame (the tool's textual result is a one-line confirmation), so a transcript
   * reopened tomorrow can either have kept it or have lost it. Absent on every other tool.
   */
  diff?: DiffHunk[];
};

export type ErrorPayload = {
  type: typeof EMessageType.error;
  title: string;
  detail?: string;
  /** Terminal errors offer `r to retry`; transient ones are just a record that it happened. */
  retryable?: boolean;
};

/**
 * WHAT Atlas is saying, given that `harness` already says who is saying it. Variants live in the
 * payload rather than in `EMessageType` so the enum stays the size of the render map: a new kind of
 * injection is a new variant the renderer labels, not a new message type nothing knows how to draw.
 */
export enum EHarnessVariant {
  /** The brief a thread is opened with, so it starts knowing what it is for. */
  seed = 'seed',
  /** The previous leg's hand-off, delivered as the successor's first message. */
  handoff = 'handoff',
  /** A boundary the agent has to act on — a phase advance, a thread it now owns. */
  transition = 'transition',
  /** Bookkeeping the agent should know about but need not act on. */
  notice = 'notice',
}

/**
 * Atlas speaking into a running session in its own name.
 *
 * It is a persisted message like any other, deliberately: a hand-off the agent was given is part of
 * why the next twenty turns went the way they did, and a transcript that hides it is a transcript
 * that lies about who said what.
 */
export type HarnessPayload = {
  type: typeof EMessageType.harness;
  variant: EHarnessVariant;
  /**
   * The PROSE. Where `attachments` is set the file bodies are not in here — the wire string is
   * assembled from both at send, so the transcript can draw chips without parsing a composed message
   * back apart, and neither copy can drift from the other. A message stored before this build simply
   * has no manifest and its text is the whole composition, which still renders.
   */
  text: string;
  attachments?: readonly AttachmentPart[];
};

export type MessagePayload =
  | UserPayload
  | AssistantPayload
  | ThinkingPayload
  | ToolCallPayload
  | ToolResultPayload
  | ErrorPayload
  | HarnessPayload;

const PAYLOAD_TYPES: ReadonlySet<string> = new Set(Object.values(EMessageType));

/**
 * A stored payload, or `null` when the row is not one.
 *
 * Only the discriminant is checked, deliberately. Payloads are written by `toPayload` and never by
 * a user, so the realistic failure is not a corrupt field — it is a row written by an OLDER build,
 * whose `type` this build has never heard of. That is exactly what the discriminant catches, and
 * validating every field would mean re-declaring the whole union as a runtime schema for a class of
 * bug that cannot happen.
 */
export function asMessagePayload(value: unknown): MessagePayload | null {
  if (typeof value !== 'object' || value === null || !('type' in value)) return null;
  const { type } = value;
  if (typeof type !== 'string' || !PAYLOAD_TYPES.has(type)) return null;
  const payload = value as MessagePayload;
  return payload.type === EMessageType.tool_result ? plainResult(payload) : payload;
}

/**
 * A stored tool result with the terminal's own bytes taken back out.
 *
 * The write path strips them (`flattenResult`), so this is only ever about rows written BEFORE it
 * did — the same "an older build wrote this" case the guard above exists for. It earns the cost
 * because one bad row is not one bad row: an escape sequence in a cell desynchronises the renderer
 * from the screen and smears fragments across the whole frame. See `plain-text.ts`.
 */
function plainResult(payload: ToolResultPayload): ToolResultPayload {
  return {
    ...payload,
    summary: stripTerminalControls(payload.summary),
    detail: payload.detail.map(stripTerminalControls),
  };
}

/**
 * What an unreadable row renders as. A transcript is append-only history, so one row this build
 * cannot parse must cost exactly one block — throwing here would take the whole conversation down
 * with it, which is a far worse answer to "we shipped a schema change".
 */
export function unreadablePayload(args: { id: string }): ErrorPayload {
  return {
    type: EMessageType.error,
    title: 'unreadable message',
    detail: `message ${args.id} was stored in a format this build does not recognise`,
  };
}

export type Message = {
  id: string;
  threadId: string;
  sessionId: string;
  ordinal: number;
  payload: MessagePayload;
  createdAt: Date;
};

export type EngineEvent =
  | { kind: 'session'; engineSessionId: string; model?: string }
  | { kind: 'text_delta'; text: string }
  | { kind: 'thinking_delta'; text: string }
  | { kind: 'text'; text: string }
  | { kind: 'thinking'; text: string }
  /**
   * `parentToolUseId` marks a call a DELEGATE made, inside its own context window. It is not this
   * thread's work and never enters this thread's transcript — it is counted against the delegate that
   * made it and thrown away with the turn. See `domain/delegates.ts`.
   */
  | {
      kind: 'tool_call';
      toolUseId: string;
      name: string;
      target?: string;
      input: unknown;
      parentToolUseId?: string;
    }
  | {
      kind: 'tool_result';
      toolUseId: string;
      ok: boolean;
      summary: string;
      detail: string[];
      diff?: DiffHunk[];
      parentToolUseId?: string;
    }
  | { kind: 'error'; title: string; detail?: string; retryable?: boolean }
  /**
   * `parentToolUseId` marks a reading that belongs to a SUBAGENT, which runs in its own separate
   * context window. Those readings are real, but they are not the main thread's occupancy and must
   * never move the composer's meter.
   */
  | { kind: 'usage'; contextTokens: number; contextLimit: number; parentToolUseId?: string }
  /** Everything a run this thread DELEGATED reports about itself — see `delegate-events.ts`. */
  | DelegateEvent
  | { kind: 'rate_limit'; window: UsageWindowKey; utilization: number; resetsAt?: string }
  /** The engine actually took a queued steer. A queued item leaves the UI on this, not on hope. */
  | { kind: 'input_ack'; text: string }
  /** `usage` is absent when the turn died before the engine could report — an interrupt, a spawn
   *  failure. The duration is still real in that case; the tokens simply are not known. */
  | { kind: 'result'; ok: boolean; text?: string; usage?: TurnUsage };

/**
 * An accounting record taken at the end of a turn, about spend — deliberately not the same shape as
 * `{ kind: 'usage' }`, which is a context-pressure reading taken mid-turn, about occupancy.
 */
export type TurnUsage = {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd?: number;
  /** What actually served the turn, which can differ from the session's model on a fallback. */
  model?: string;
};

export type TurnSummary = { durationMs: number; outputTokens: number };

export type UsageWindowKey = 'fiveHour' | 'sevenDay';

/** Only these persist; everything else is live-only. */
export function isAuthoritative(event: EngineEvent): boolean {
  // A delegate's calls are the one exception with a `kind` on this list. They are authoritative about
  // the DELEGATE and say nothing about this thread, so persisting them wrote another agent's work
  // into a transcript that never did it — see `toPayload`.
  if (
    (event.kind === 'tool_call' || event.kind === 'tool_result') &&
    event.parentToolUseId !== undefined
  )
    return false;
  return (
    event.kind === 'text' ||
    event.kind === 'thinking' ||
    event.kind === 'tool_call' ||
    event.kind === 'tool_result' ||
    event.kind === 'error'
  );
}

/**
 * What a turn can be FIRED from. Everything else in the union is a record of what came back, and
 * `toPayload` is how it got there — this type is the other end of the same conversation.
 */
export type PromptPayload = UserPayload | HarnessPayload;

/**
 * Whose turn this is. The absence of a variant is the human — the default has to be the bare one, so
 * that forgetting to pass a variant under-tags rather than mislabels Dennis as the harness.
 *
 * Paired with `renderPrompt`: this decides what is STORED, that decides what is SENT, and they are
 * two directions off the one payload rather than two independent decisions that can disagree.
 */
export function promptPayload(args: {
  text: string;
  harnessVariant?: EHarnessVariant | undefined;
  /**
   * The seam's attachment manifest. Only Atlas attaches — a message Dennis typed has no manifest,
   * so this is dropped rather than mislabelled when no variant came with it.
   */
  attachments?: readonly AttachmentPart[] | undefined;
}): PromptPayload {
  if (args.harnessVariant === undefined)
    return { type: EMessageType.user, text: args.text };
  return {
    type: EMessageType.harness,
    variant: args.harnessVariant,
    text: args.text,
    // Absent rather than empty when nothing was attached: an empty array would draw an empty chip
    // list's worth of nothing and would claim, on an old row, that the seam attached nothing.
    ...(args.attachments && args.attachments.length > 0
      ? { attachments: args.attachments }
      : {}),
  };
}

/**
 * Payload → the string the model actually receives. The mirror of `toPayload()`: one turns an engine
 * event into a payload, this turns a payload into a prompt, and between them nothing above `engine/`
 * has to know what a prompt looks like on the wire.
 *
 * **Dennis's words go in bare.** There is no mid-conversation system role — the only channel into a
 * running session is a user-role prompt — so the envelope is the entire distinction between Atlas
 * and the human, and it is worth something only while it stays rare. Tag every message and the tag
 * says nothing. (Claude Code does the same thing to itself with `<system-reminder>`.)
 */
export function renderPrompt(payload: PromptPayload): string {
  if (payload.type === EMessageType.user) return payload.text;
  // Prose, then the files, in the order `successorSeed` has always put them: the attachments are the
  // material and read as nothing until the prose has said what they are for. Composed HERE rather
  // than stored composed, so the model and the chips are two views of one manifest.
  const attachments = renderAttachmentParts(payload.attachments ?? []);
  const body =
    attachments.length > 0 ? `${payload.text}\n\n${attachments}` : payload.text;
  return `<harness variant="${payload.variant}">${escapeEnvelope(body)}</harness>`;
}

/**
 * `<` becomes `&lt;` on the way in, because injected text is not trusted prose. A hand-off is written
 * by one agent and read by another, and a delegate's report is agent-generated text entering a
 * second agent's prompt — without this, either could close the envelope early and forge a
 * `<harness variant="transition">` instructing the reader to advance a phase.
 *
 * Only `<` is escaped. It is the one character that can start a tag, and escaping `&` as well would
 * turn every `R&D` in a hand-off into noise to close a hole that does not exist. The `variant`
 * attribute is never free text — it comes from `EHarnessVariant` — so there is nothing to quote.
 */
function escapeEnvelope(text: string): string {
  return text.replaceAll('<', '&lt;');
}

export function toPayload(event: EngineEvent): MessagePayload | null {
  // A DELEGATE's call, not this thread's. The subagent runs in its own context window and reports back
  // through the spawning tool's result; its intermediate calls arriving on the same stream is an
  // accident of transport, not a claim that this thread made them. Persisting them put another agent's
  // fifteen greps into the transcript of the conversation that delegated precisely to avoid them.
  if (
    (event.kind === 'tool_call' || event.kind === 'tool_result') &&
    event.parentToolUseId !== undefined
  )
    return null;

  switch (event.kind) {
    case 'text':
      return { type: EMessageType.assistant, text: event.text };
    case 'thinking':
      return { type: EMessageType.thinking, text: event.text };
    case 'tool_call':
      return {
        type: EMessageType.tool_call,
        toolUseId: event.toolUseId,
        name: event.name,
        ...(event.target === undefined ? {} : { target: event.target }),
        input: event.input,
      };
    case 'tool_result':
      return {
        type: EMessageType.tool_result,
        toolUseId: event.toolUseId,
        ok: event.ok,
        summary: event.summary,
        detail: event.detail,
        ...(event.diff === undefined ? {} : { diff: event.diff }),
      };
    case 'error':
      return {
        type: EMessageType.error,
        title: event.title,
        ...(event.detail === undefined ? {} : { detail: event.detail }),
        ...(event.retryable === undefined ? {} : { retryable: event.retryable }),
      };
    default:
      return null;
  }
}
