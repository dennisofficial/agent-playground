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
 * A DELEGATE's own output, forwarded onto the parent's stream.
 *
 * A subagent's tool calls and prose arrive as ordinary `assistant`/`user` frames carrying the
 * `parent_tool_use_id` of the call that spawned them — they are the bulk of a held turn's traffic, and
 * they are not the parent model doing anything. Two shapes, because they behave differently
 * downstream: the tool call normalises to an event that carries `parentToolUseId`, while the prose
 * normalises to a bare `text` event that does not, so only the FRAME can say whose it is.
 */
export function delegateToolUse(
  id = 'tool-delegate',
  parentToolUseId = 'toolu_parent',
): SDKMessage {
  return {
    ...(assistant([{ type: 'tool_use', id, name: 'Read', input: {} }]) as object),
    parent_tool_use_id: parentToolUseId,
  } as unknown as SDKMessage;
}

export function delegateText(
  text = 'searching the repo for the caller',
  parentToolUseId = 'toolu_parent',
): SDKMessage {
  return {
    ...(assistantText(text) as object),
    parent_tool_use_id: parentToolUseId,
  } as unknown as SDKMessage;
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

/**
 * A subagent's SUMMARIZED THINKING block — the frame that proved `forwardSubagentText: false` is not a
 * guarantee about prose.
 *
 * Copied from a real tape: 19 of these arrived on one thread's stream under a single `Agent` call, and
 * every one was persisted as the parent's own reasoning, because the assistant loop tagged `tool_use`
 * and dropped the tag on `thinking`. The visible symptom was five consecutive "Thinking…" blocks in a
 * thread that had produced one.
 */
export function subagentThinking(parentToolUseId: string, thinking: string): SDKMessage {
  return {
    ...(assistant([{ type: 'thinking', thinking }]) as object),
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

/**
 * The CLI handing a user message back at the moment it goes to the model — what
 * `--replay-user-messages` buys, and the only "seen" signal on the wire. Same `type: 'user'` as a
 * tool result, told apart by `isReplay`.
 */
export function userReplay(uuid: string, text: string): SDKMessage {
  return {
    type: 'user',
    session_id: SESSION_ID,
    parent_tool_use_id: null,
    uuid,
    isReplay: true,
    message: { role: 'user', content: text },
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

/**
 * The wallet itself refusing: `rateLimitType: 'overage'` with a top-level rejection. The turn is
 * refused over MONEY, and no subscription window is implicated — which is exactly the distinction
 * the normaliser has to keep.
 */
export function overageRejected(): SDKMessage {
  return {
    type: 'rate_limit_event',
    session_id: SESSION_ID,
    uuid: 'u-rl-overage',
    rate_limit_info: {
      status: 'rejected',
      rateLimitType: 'overage',
      utilization: 100,
      overageStatus: 'rejected',
      errorCode: 'credits_required',
    },
  } as unknown as SDKMessage;
}

/** The five-hour window is gone and the turn is being served on credits anyway. */
export function usingOverage(): SDKMessage {
  return {
    type: 'rate_limit_event',
    session_id: SESSION_ID,
    uuid: 'u-rl-using',
    rate_limit_info: {
      status: 'rejected',
      rateLimitType: 'five_hour',
      overageStatus: 'allowed',
      isUsingOverage: true,
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

/**
 * A subagent's TOOL call, which is the only thing a subagent forwards by default.
 *
 * A delegate's `tool_use` and `tool_result` blocks always arrive, whatever `forwardSubagentText` says —
 * which made them, for a while, the entire visible symptom of the leak. A real tape holds 31 of each in
 * one turn. What that flag does NOT suppress is summarized thinking; see `subagentThinking`.
 */
export function subagentToolUse(
  parentToolUseId: string,
  toolUseId: string,
  name: string,
  input: unknown,
): SDKMessage {
  return {
    type: 'assistant',
    session_id: SESSION_ID,
    parent_tool_use_id: parentToolUseId,
    uuid: `u-sub-${toolUseId}`,
    message: {
      role: 'assistant',
      model: 'claude-opus-5',
      content: [{ type: 'tool_use', id: toolUseId, name, input }],
    },
  } as unknown as SDKMessage;
}

export function subagentToolResult(
  parentToolUseId: string,
  toolUseId: string,
  lines: string[],
): SDKMessage {
  return {
    type: 'user',
    session_id: SESSION_ID,
    parent_tool_use_id: parentToolUseId,
    uuid: `u-sub-result-${toolUseId}`,
    message: {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: toolUseId, content: lines.join('\n') }],
    },
  } as unknown as SDKMessage;
}

/** The SDK's delegate bookkeeping, shaped as the tapes actually hold it. */
export function taskStarted(
  overrides: Record<string, unknown> = {},
): SDKMessage {
  return {
    type: 'system',
    subtype: 'task_started',
    session_id: SESSION_ID,
    uuid: 'u-task-started',
    task_id: 'a6a85ea2f071bc16e',
    tool_use_id: 'toolu_parent',
    description: 'Find transcript markdown rendering',
    subagent_type: 'Explore',
    task_type: 'local_agent',
    ...overrides,
  } as unknown as SDKMessage;
}

export function taskProgress(
  overrides: Record<string, unknown> = {},
): SDKMessage {
  return {
    type: 'system',
    subtype: 'task_progress',
    session_id: SESSION_ID,
    uuid: 'u-task-progress',
    task_id: 'a6a85ea2f071bc16e',
    tool_use_id: 'toolu_parent',
    description: 'Find transcript markdown rendering',
    subagent_type: 'Explore',
    usage: { total_tokens: 11_511, tool_uses: 14, duration_ms: 32_000 },
    last_tool_name: 'Grep',
    summary: 'Analyzing the markdown layer',
    ...overrides,
  } as unknown as SDKMessage;
}

export function taskNotification(
  overrides: Record<string, unknown> = {},
): SDKMessage {
  return {
    type: 'system',
    subtype: 'task_notification',
    session_id: SESSION_ID,
    uuid: 'u-task-notification',
    task_id: 'a6a85ea2f071bc16e',
    tool_use_id: 'toolu_parent',
    status: 'completed',
    output_file: '/tmp/tasks/a6a85ea2f071bc16e.output',
    summary: '6 files, 2 gaps found',
    ...overrides,
  } as unknown as SDKMessage;
}

export function backgroundTasksChanged(
  tasks: { task_id: string; task_type: string; description: string }[],
): SDKMessage {
  return {
    type: 'system',
    subtype: 'background_tasks_changed',
    session_id: SESSION_ID,
    uuid: 'u-bg-changed',
    tasks,
  } as unknown as SDKMessage;
}
