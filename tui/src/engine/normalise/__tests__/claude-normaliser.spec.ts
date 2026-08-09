import { describe, expect, it } from 'bun:test';
import type { EngineEvent } from '../../../domain/message.js';
import {
  ClaudeNormaliserService,
  createNormaliseContext,
  flattenResult,
} from '../claude-normaliser.service.js';
import {
  assistantText,
  assistantToolUse,
  init,
  rateLimit,
  rateLimitWithoutUtilisation,
  result,
  scriptedTurn,
  SESSION_ID,
  subagentAssistant,
  syntheticAssistant,
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

describe('flattenResult', () => {
  it('accepts a string, a block array, or nothing', () => {
    expect(flattenResult('a\nb')).toEqual(['a', 'b']);
    expect(flattenResult([{ type: 'text', text: 'a\nb' }])).toEqual(['a', 'b']);
    expect(flattenResult(null)).toEqual([]);
  });
});
