import { EMessageType } from '../generated/prisma/enums.js';

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
};

export type ErrorPayload = {
  type: typeof EMessageType.error;
  title: string;
  detail?: string;
  /** Terminal errors offer `r to retry`; transient ones are just a record that it happened. */
  retryable?: boolean;
};

export type MessagePayload =
  | UserPayload
  | AssistantPayload
  | ThinkingPayload
  | ToolCallPayload
  | ToolResultPayload
  | ErrorPayload;

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
  | { kind: 'tool_call'; toolUseId: string; name: string; target?: string; input: unknown }
  | { kind: 'tool_result'; toolUseId: string; ok: boolean; summary: string; detail: string[] }
  | { kind: 'error'; title: string; detail?: string; retryable?: boolean }
  /**
   * `parentToolUseId` marks a reading that belongs to a SUBAGENT, which runs in its own separate
   * context window. Those readings are real, but they are not the main thread's occupancy and must
   * never move the composer's meter.
   */
  | { kind: 'usage'; contextTokens: number; contextLimit: number; parentToolUseId?: string }
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
  return (
    event.kind === 'text' ||
    event.kind === 'thinking' ||
    event.kind === 'tool_call' ||
    event.kind === 'tool_result' ||
    event.kind === 'error'
  );
}

export function toPayload(event: EngineEvent): MessagePayload | null {
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
