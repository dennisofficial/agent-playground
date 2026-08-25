import { SetMetadata } from '@nestjs/common';

export enum EJitTrigger {
  TOOL_MATCH = 'tool-match', // a Bash/tool call matched a predicate (e.g. an install command)
  URL_MATCH = 'url-match', // a WebFetch/fetch targeted a matched URL
  TOKEN_THRESHOLD = 'token-threshold', // context token count crossed a soft/hard line
  HOLD_TIMER = 'hold-timer', // a background hold exceeded a duration
  LIFECYCLE = 'lifecycle', // a pipeline lifecycle event (e.g. plan-approved)
  OPERATOR_MESSAGE = 'operator-message', // an inbound operator message
}

export enum EJitDelivery {
  POST_TOOL_USE = 'postToolUse', // inject `additionalContext` after a tool call (SDK-native, in-sandbox)
  STEER = 'steer', // steer the running turn (host → sandbox)
  SEED = 'seed', // seed a system chat message
  TURN_PREFIX = 'turn-prefix', // prepend a chunk to the next turn
}

export interface JitHookMeta {
  /** Stable rule id (e.g. `install-awareness`). */
  id: string;
  trigger: EJitTrigger;
  delivery: EJitDelivery;
  /** Optional min-interval throttle, in output tokens, between firings. */
  throttleTokens?: number;
}

export const JIT_HOOK_METADATA = Symbol('JIT_HOOK_METADATA');

export const JitHook = (meta: JitHookMeta): MethodDecorator => SetMetadata(JIT_HOOK_METADATA, meta);
