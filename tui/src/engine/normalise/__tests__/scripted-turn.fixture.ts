import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';

/**
 * The scripted turn: text → thinking → tool → result → text.
 *
 * This is the regression net for the renderer now. When Codex lands, replaying the SAME logical
 * turn through both normalisers and asserting identical domain output is what proves the
 * abstraction holds — so keep this fixture engine-shaped, not Claude-shaped, in what it exercises.
 */
export const SESSION_ID = '11111111-2222-3333-4444-555555555555';

export function scriptedTurn(): SDKMessage[] {
  return [
    init(),
    textDelta('Let me look at '),
    textDelta('how the queue drains.'),
    assistantText('Let me look at how the queue drains.'),
    thinkingDelta('The dispatcher drains the queue '),
    assistantThinking('The dispatcher drains the queue before re-entering the tool loop.'),
    assistantToolUse('tool-1', 'Read', { file_path: '/repo/backend/src/host/turn-dispatcher.service.ts' }),
    toolResult('tool-1', ['line 1', 'line 2', 'line 3']),
    assistantText('Fixed — the queue was drained before the tool loop re-entered.'),
    rateLimit('five_hour', 0.34),
    result('Fixed.'),
  ];
}

export function init(model = 'claude-opus-5'): SDKMessage {
  return {
    type: 'system',
    subtype: 'init',
    session_id: SESSION_ID,
    model,
    cwd: '/repo',
    tools: [],
    mcp_servers: [],
    apiKeySource: 'none',
    permissionMode: 'bypassPermissions',
    slash_commands: [],
    output_style: 'default',
    skills: [],
    plugins: [],
    uuid: 'u-init',
  } as unknown as SDKMessage;
}

export function textDelta(text: string): SDKMessage {
  return {
    type: 'stream_event',
    session_id: SESSION_ID,
    parent_tool_use_id: null,
    uuid: 'u-delta',
    event: { type: 'content_block_delta', delta: { type: 'text_delta', text } },
  } as unknown as SDKMessage;
}

export function thinkingDelta(text: string): SDKMessage {
  return {
    type: 'stream_event',
    session_id: SESSION_ID,
    parent_tool_use_id: null,
    uuid: 'u-tdelta',
    event: { type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: text } },
  } as unknown as SDKMessage;
}

export function assistantText(text: string, usage?: Record<string, number>): SDKMessage {
  return assistant([{ type: 'text', text }], usage);
}

export function assistantThinking(thinking: string): SDKMessage {
  return assistant([{ type: 'thinking', thinking }]);
}

export function assistantToolUse(id: string, name: string, input: unknown): SDKMessage {
  return assistant([{ type: 'tool_use', id, name, input }]);
}

/**
 * The all-zero `<synthetic>` frame the SDK emits as a turn unwinds. Real, and the reason `ctx` used
 * to read 0% after every turn.
 */
export function syntheticAssistant(): SDKMessage {
  return assistant(
    [{ type: 'text', text: '' }],
    { input_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 0 },
    '<synthetic>',
  );
}

/**
 * A frame from inside a Task subagent, which runs in its OWN context window. A real tape holds 136
 * of these in one turn, reading anywhere from 11k to 122k tokens.
 */
export function subagentAssistant(
  parentToolUseId: string,
  usage: Record<string, number>,
): SDKMessage {
  return {
    ...(assistant([{ type: 'text', text: 'sub' }], usage) as object),
    parent_tool_use_id: parentToolUseId,
  } as unknown as SDKMessage;
}

function assistant(
  content: unknown[],
  usage?: Record<string, number>,
  model = 'claude-opus-5',
): SDKMessage {
  return {
    type: 'assistant',
    session_id: SESSION_ID,
    parent_tool_use_id: null,
    uuid: 'u-assistant',
    message: {
      role: 'assistant',
      model,
      content,
      ...(usage ? { usage } : {}),
    },
  } as unknown as SDKMessage;
}

/** `toolUseResult` rides on the FRAME, beside `message` — that is where the SDK puts a patch. */
export function toolResult(
  toolUseId: string,
  lines: string[],
  isError = false,
  toolUseResult?: unknown,
): SDKMessage {
  return {
    type: 'user',
    session_id: SESSION_ID,
    parent_tool_use_id: null,
    uuid: 'u-result',
    message: {
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: toolUseId, content: lines.join('\n'), is_error: isError },
      ],
    },
    ...(toolUseResult === undefined ? {} : { tool_use_result: toolUseResult }),
  } as unknown as SDKMessage;
}

export function rateLimit(rateLimitType: string, utilization: number, resetsAt?: number): SDKMessage {
  return {
    type: 'rate_limit_event',
    session_id: SESSION_ID,
    uuid: 'u-rl',
    rate_limit_info: {
      status: 'allowed',
      rateLimitType,
      utilization,
      ...(resetsAt ? { resetsAt } : {}),
    },
  } as unknown as SDKMessage;
}

/**
 * What these frames ACTUALLY look like in a captured tape: a verdict and a reset time, and no
 * `utilization` field at all. Pinned so nobody rebuilds the meters on top of them again.
 */
export function rateLimitWithoutUtilisation(status = 'allowed'): SDKMessage {
  return {
    type: 'rate_limit_event',
    session_id: SESSION_ID,
    uuid: 'u-rl-bare',
    rate_limit_info: {
      status,
      rateLimitType: 'five_hour',
      resetsAt: 1785666000,
      overageStatus: 'rejected',
    },
  } as unknown as SDKMessage;
}

export function result(
  text: string,
  isError = false,
  overrides: Record<string, unknown> = {},
): SDKMessage {
  return {
    type: 'result',
    subtype: 'success',
    session_id: SESSION_ID,
    uuid: 'u-result-final',
    is_error: isError,
    result: text,
    duration_ms: 1,
    duration_api_ms: 1,
    num_turns: 1,
    stop_reason: 'end_turn',
    total_cost_usd: 0,
    usage: {},
    modelUsage: {},
    permission_denials: [],
    ...overrides,
  } as unknown as SDKMessage;
}
