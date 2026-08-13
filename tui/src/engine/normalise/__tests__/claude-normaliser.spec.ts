import { describe, expect, it } from 'bun:test';
import { EDelegateStatus, type EngineEvent } from '../../../domain/message.js';
import {
  ClaudeNormaliserService,
  createNormaliseContext,
  flattenResult,
} from '../claude-normaliser.service.js';
import {
  assistantText,
  assistantToolUse,
  backgroundTasksChanged,
  init,
  rateLimit,
  rateLimitWithoutUtilisation,
  result,
  scriptedTurn,
  SESSION_ID,
  subagentAssistant,
  subagentToolResult,
  subagentToolUse,
  syntheticAssistant,
  taskNotification,
  taskProgress,
  taskStarted,
  textDelta,
  thinkingDelta,
  toolResult,
} from './scripted-turn.fixture.js';

/**
 * Table-driven: SDK event in, domain payload out. The highest-value tests in the codebase — this is
 * the file most likely to become shared code, and the one an SDK upgrade breaks first.
 */
function run(messages: Parameters<ClaudeNormaliserService['normalise']>[0][], cwd = '/repo'): EngineEvent[] {
  const service = new ClaudeNormaliserService();
  const context = createNormaliseContext(cwd);
  return messages.flatMap((message) => service.normalise(message, context));
}

describe('ClaudeNormaliserService', () => {
  it('reports the session id from the init frame', () => {
    expect(run([init()])).toEqual([
      { kind: 'session', engineSessionId: SESSION_ID, model: 'claude-opus-5' },
    ]);
  });

  it('maps text and thinking deltas to live-only events', () => {
    expect(run([textDelta('abc'), thinkingDelta('xyz')])).toEqual([
      { kind: 'text_delta', text: 'abc' },
      { kind: 'thinking_delta', text: 'xyz' },
    ]);
  });

  it('treats the assistant block as authoritative, not the deltas that built it', () => {
    const events = run([textDelta('Let me '), textDelta('look.'), assistantText('Let me look.')]);
    expect(events.filter((e) => e.kind === 'text')).toEqual([{ kind: 'text', text: 'Let me look.' }]);
  });

  it('relativises a tool target against the project root', () => {
    const events = run([
      assistantToolUse('t1', 'Read', { file_path: '/repo/backend/src/host/dispatcher.ts' }),
    ]);
    expect(events[0]).toMatchObject({
      kind: 'tool_call',
      name: 'Read',
      target: 'backend/src/host/dispatcher.ts',
    });
  });

  it('summarises a Read result by line count, remembering the call it belongs to', () => {
    const events = run([
      assistantToolUse('t1', 'Read', { file_path: '/repo/a.ts' }),
      toolResult('t1', ['a', 'b', 'c']),
    ]);
    expect(events.at(-1)).toEqual({
      kind: 'tool_result',
      toolUseId: 't1',
      ok: true,
      summary: 'Read 3 lines',
      detail: ['a', 'b', 'c'],
    });
  });

  it('carries an edit’s patch through, off the frame rather than the result text', () => {
    const events = run([
      assistantToolUse('t1', 'Edit', { file_path: '/repo/a.ts' }),
      toolResult('t1', ['The file /repo/a.ts has been updated successfully.'], false, {
        filePath: '/repo/a.ts',
        structuredPatch: [
          { oldStart: 12, oldLines: 2, newStart: 12, newLines: 2, lines: [' ok', '-was', '+is'] },
        ],
      }),
    ]);
    expect(events.at(-1)).toEqual({
      kind: 'tool_result',
      toolUseId: 't1',
      ok: true,
      summary: 'Updated with 1 addition and 1 removal',
      detail: ['The file /repo/a.ts has been updated successfully.'],
      diff: [{ oldStart: 12, newStart: 12, lines: [' ok', '-was', '+is'] }],
    });
  });

  it('leaves the diff off a tool that did not edit a file', () => {
    const events = run([
      assistantToolUse('t1', 'Bash', { command: 'ls' }),
      toolResult('t1', ['a.ts'], false, { content: 'a.ts' }),
    ]);
    expect(events.at(-1)).not.toHaveProperty('diff');
  });

  it('keeps a failed tool result and marks it not-ok', () => {
    const events = run([
      assistantToolUse('t1', 'Bash', { command: 'pnpm test' }),
      toolResult('t1', ['FAIL steer.spec.ts', 'exit 1'], true),
    ]);
    expect(events.at(-1)).toEqual({
      kind: 'tool_result',
      toolUseId: 't1',
      ok: false,
      summary: 'FAIL steer.spec.ts',
      detail: ['exit 1'],
    });
  });

  it('normalises fractional and percentage utilisation the same way', () => {
    expect(run([rateLimit('five_hour', 0.34)])).toEqual([
      { kind: 'rate_limit', window: 'fiveHour', utilization: 34 },
    ]);
    expect(run([rateLimit('seven_day', 61)])).toEqual([
      { kind: 'rate_limit', window: 'sevenDay', utilization: 61 },
    ]);
  });

  it('folds every seven-day variant onto the one weekly meter', () => {
    expect(run([rateLimit('seven_day_opus', 0.5)])[0]).toMatchObject({ window: 'sevenDay' });
    expect(run([rateLimit('seven_day_sonnet', 0.5)])[0]).toMatchObject({ window: 'sevenDay' });
  });

  it('drops rate-limit windows it does not model rather than inventing one', () => {
    expect(run([rateLimit('overage', 0.5)])).toEqual([]);
  });

  it('drops a rate-limit frame that carries no utilisation — the common real shape', () => {
    // These arrive with a verdict and a reset and no number. The meters come from the usage API
    // instead (AccountUsageService); guessing one here would show a made-up percentage.
    expect(run([rateLimitWithoutUtilisation()])).toEqual([]);
  });

  it('reads a rejection as a spent window, number or no number', () => {
    expect(run([rateLimitWithoutUtilisation('rejected')])).toEqual([
      {
        kind: 'rate_limit',
        window: 'fiveHour',
        utilization: 100,
        resetsAt: new Date(1785666000 * 1000).toISOString(),
      },
    ]);
  });

  it('derives context pressure from input plus both cache halves', () => {
    const message = assistantText('hi', {
      input_tokens: 1000,
      cache_read_input_tokens: 500,
      cache_creation_input_tokens: 500,
    });
    const usage = run([message]).find((e) => e.kind === 'usage');
    expect(usage).toEqual({ kind: 'usage', contextTokens: 2000, contextLimit: 1_000_000 });
  });

  it("tags a subagent's reading, because it measures a different context window", () => {
    const events = run([
      subagentAssistant('task-1', {
        input_tokens: 500,
        cache_read_input_tokens: 11_000,
        cache_creation_input_tokens: 11,
      }),
    ]);
    expect(events.find((e) => e.kind === 'usage')).toEqual({
      kind: 'usage',
      contextTokens: 11_511,
      contextLimit: 1_000_000,
      parentToolUseId: 'task-1',
    });
  });

  it('ignores the all-zero <synthetic> frame instead of reading it as an empty context', () => {
    const events = run([
      assistantText('hi', {
        input_tokens: 1000,
        cache_read_input_tokens: 500,
        cache_creation_input_tokens: 500,
      }),
      syntheticAssistant(),
    ]);
    // One reading, from the real frame. The synthetic one used to stomp the meter to ctx 0%.
    expect(events.filter((e) => e.kind === 'usage')).toEqual([
      { kind: 'usage', contextTokens: 2000, contextLimit: 1_000_000 },
    ]);
  });

  it('carries the terminal frame\u2019s real token counts — the only place they appear', () => {
    const events = run([
      result('done', false, {
        usage: {
          input_tokens: 31,
          output_tokens: 4_200,
          cache_read_input_tokens: 90_000,
          cache_creation_input_tokens: 1_100,
        },
        total_cost_usd: 0.42,
        modelUsage: {
          'claude-haiku-4-5': { outputTokens: 12 },
          'claude-opus-5': { outputTokens: 4_188 },
        },
      }),
    ]);
    expect(events).toEqual([
      {
        kind: 'result',
        ok: true,
        text: 'done',
        usage: {
          inputTokens: 31,
          outputTokens: 4_200,
          cacheReadTokens: 90_000,
          cacheWriteTokens: 1_100,
          costUsd: 0.42,
          // Two models served this turn; the heavier one is the one worth naming.
          model: 'claude-opus-5',
        },
      },
    ]);
  });

  it('leaves cost off a subscription turn rather than recording $0 as a price', () => {
    const events = run([result('done', false, { usage: { output_tokens: 10 }, total_cost_usd: 0 })]);
    expect(events[0]).toMatchObject({ kind: 'result', usage: { outputTokens: 10 } });
    expect((events[0] as { usage: Record<string, unknown> }).usage.costUsd).toBeUndefined();
  });

  it('produces the full grammar for a scripted turn, in order', () => {
    const kinds = run(scriptedTurn()).map((e) => e.kind);
    expect(kinds).toEqual([
      'session',
      'text_delta',
      'text_delta',
      'text',
      'thinking_delta',
      'thinking',
      'tool_call',
      'tool_result',
      'text',
      'rate_limit',
      'result',
    ]);
  });

  it('never emits an SDK type — every event is a domain event', () => {
    for (const event of run(scriptedTurn())) {
      expect(event).not.toHaveProperty('session_id');
      expect(event).not.toHaveProperty('uuid');
    }
  });
});

describe('a delegate on the parent stream', () => {
  it("tags a subagent's tool call, so nothing downstream can mistake it for this thread's", () => {
    const events = run([
      subagentToolUse('toolu_parent', 'toolu_sub', 'Grep', { pattern: 'markdown' }),
    ]);
    expect(events).toEqual([
      {
        kind: 'tool_call',
        toolUseId: 'toolu_sub',
        name: 'Grep',
        target: 'markdown',
        input: { pattern: 'markdown' },
        parentToolUseId: 'toolu_parent',
      },
    ]);
  });

  it("tags a subagent's tool result the same way", () => {
    const events = run([
      subagentToolUse('toolu_parent', 'toolu_sub', 'Grep', { pattern: 'markdown' }),
      subagentToolResult('toolu_parent', 'toolu_sub', ['6 matches']),
    ]);
    const settled = events.find((event) => event.kind === 'tool_result');
    expect(settled).toMatchObject({
      toolUseId: 'toolu_sub',
      parentToolUseId: 'toolu_parent',
    });
  });

  it("drops a subagent's deltas — its prose must never stream into this thread's tail", () => {
    const delta = {
      type: 'stream_event',
      session_id: SESSION_ID,
      parent_tool_use_id: 'toolu_parent',
      uuid: 'u-sub-delta',
      event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'sub' } },
    } as unknown as Parameters<ClaudeNormaliserService['normalise']>[0];
    expect(run([delta])).toEqual([]);
  });

  it('reads the three task bookends off the system stream', () => {
    expect(run([taskStarted()])).toEqual([
      {
        kind: 'task_started',
        taskId: 'a6a85ea2f071bc16e',
        parentToolUseId: 'toolu_parent',
        description: 'Find transcript markdown rendering',
        agentType: 'Explore',
        taskType: 'local_agent',
        background: false,
      },
    ]);
    expect(run([taskProgress()])).toEqual([
      {
        kind: 'task_progress',
        taskId: 'a6a85ea2f071bc16e',
        parentToolUseId: 'toolu_parent',
        toolUses: 14,
        durationMs: 32_000,
        lastTool: 'Grep',
        summary: 'Analyzing the markdown layer',
      },
    ]);
    expect(run([taskNotification()])).toEqual([
      {
        kind: 'task_settled',
        taskId: 'a6a85ea2f071bc16e',
        parentToolUseId: 'toolu_parent',
        status: EDelegateStatus.completed,
        summary: '6 files, 2 gaps found',
      },
    ]);
  });

  it('reads an unrecognised ending as stopped rather than leaving the row running forever', () => {
    const events = run([taskNotification({ status: 'evicted' })]);
    expect(events[0]).toMatchObject({ status: EDelegateStatus.stopped });
  });

  it('drops the ambient tasks the SDK itself asks consumers to hide', () => {
    expect(run([taskStarted({ skip_transcript: true })])).toEqual([]);
    expect(run([taskNotification({ skip_transcript: true })])).toEqual([]);
  });

  it('passes the background membership level through as a whole set', () => {
    const events = run([
      backgroundTasksChanged([
        { task_id: 'a7cafbf786f3aacff', task_type: 'local_agent', description: 'Explore atlas' },
      ]),
    ]);
    expect(events).toEqual([
      {
        kind: 'background_tasks',
        tasks: [
          {
            taskId: 'a7cafbf786f3aacff',
            taskType: 'local_agent',
            description: 'Explore atlas',
          },
        ],
      },
    ]);
  });
});

describe('flattenResult', () => {
  it('accepts a string, a block array, or nothing', () => {
    expect(flattenResult('a\nb')).toEqual(['a', 'b']);
    expect(flattenResult([{ type: 'text', text: 'a\nb' }])).toEqual(['a', 'b']);
    expect(flattenResult(null)).toEqual([]);
  });
});
