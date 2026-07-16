/**
 * Regression coverage for the LIVE + end-of-turn `context_breakdown` capture in `engine-core.ts`: a fake
 * Claude SDK whose `query()` handle carries a `getContextUsage()` control method (mirroring the real SDK's
 * `Query` interface) drives the turn through a normal main-agent round-trip + success result, and asserts
 * (a) a LIVE `context_breakdown` event fires mid-turn, (b) the AWAITED end-of-turn fetch lands on
 * `result.usage.contextBreakdown`, and (c) the whole mechanism degrades gracefully — no event, no
 * `usage.contextBreakdown`, and no thrown error into the turn — when `getContextUsage` is absent (an older
 * CLI / Codex-adjacent) or rejects (a transient control-channel error).
 */
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync } from 'node:fs';
import { afterAll, describe, expect, it } from 'vitest';
import type { SDKControlGetContextUsageResponse } from '@anthropic-ai/claude-agent-sdk';
import { EngineCore } from './engine-core';
import { type EngineHomeKey } from './engine-home';
import type { ContextBreakdown, EngineEvent } from './engine.types';

const TEST_KEY: EngineHomeKey = {
  orgId: 'acme',
  repoId: 'atlas',
  jobId: 'feat',
  type: 'build',
};

const HOME_ROOT = join(tmpdir(), `atlas-context-breakdown-${process.pid}`);
afterAll(() => rmSync(HOME_ROOT, { recursive: true, force: true }));

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 5));

// ── Scripted SDK frames (only the fields the engine reads; shapes mirror @anthropic-ai/claude-agent-sdk). ──
const initMsg = (): Record<string, unknown> => ({
  type: 'system',
  subtype: 'init',
  session_id: 'sess-1',
});
const assistantWithUsage = (text: string): Record<string, unknown> => ({
  type: 'assistant',
  message: {
    model: 'opus',
    usage: {
      input_tokens: 500,
      cache_read_input_tokens: 100,
      cache_creation_input_tokens: 0,
    },
    content: [{ type: 'text', text }],
  },
});
const resultMsg = (
  result: string,
  inputTokens: number,
  outputTokens: number,
): Record<string, unknown> => ({
  type: 'result',
  subtype: 'success',
  session_id: 'sess-1',
  result,
  terminal_reason: 'completed',
  stop_reason: 'end_turn',
  usage: { input_tokens: inputTokens, output_tokens: outputTokens },
});

const CANNED_RAW: SDKControlGetContextUsageResponse = {
  categories: [
    { name: 'System prompt', tokens: 200, color: 'promptBorder' },
    { name: 'Messages', tokens: 300, color: 'purple' },
  ],
  totalTokens: 500,
  maxTokens: 967000,
  rawMaxTokens: 967000,
  percentage: 0,
  gridRows: [],
  model: 'opus',
  memoryFiles: [{ path: '/CLAUDE.md', type: 'project', tokens: 150 }],
  mcpTools: [{ name: 'tool1', serverName: 'srv', tokens: 50, isLoaded: true }],
  agents: [],
  isAutoCompactEnabled: true,
  apiUsage: null,
};

const EXPECTED_BREAKDOWN: ContextBreakdown = {
  model: 'opus',
  totalTokens: 500,
  maxTokens: 967000,
  percentage: 0,
  categories: [
    { name: 'System prompt', tokens: 200, color: 'promptBorder' },
    { name: 'Messages', tokens: 300, color: 'purple' },
  ],
  mcpTools: [{ name: 'tool1', serverName: 'srv', tokens: 50 }],
  memoryFiles: [{ path: '/CLAUDE.md', tokens: 150 }],
};

type ContextUsageBehavior = 'resolve' | 'reject' | 'absent';

/**
 * A minimal fake SDK whose `query()` returns a plain async-generator object (a non-streaming, single-message
 * turn — no steer channel needed for this coverage) with an optional `getContextUsage` control method
 * attached, mirroring how the real `Query` handle carries it alongside the async-iterable frames.
 */
function makeContextBreakdownFake(
  frames: () => AsyncGenerator<Record<string, unknown>>,
  behavior: ContextUsageBehavior,
): typeof import('@anthropic-ai/claude-agent-sdk') {
  const sdk = {
    query: () => {
      const gen = (async function* () {
        yield* frames();
      })();
      if (behavior === 'resolve') {
        (
          gen as unknown as {
            getContextUsage: () => Promise<SDKControlGetContextUsageResponse>;
          }
        ).getContextUsage = async () => CANNED_RAW;
      } else if (behavior === 'reject') {
        (
          gen as unknown as {
            getContextUsage: () => Promise<SDKControlGetContextUsageResponse>;
          }
        ).getContextUsage = async () => {
          throw new Error('getContextUsage failed');
        };
      }
      // 'absent': no getContextUsage property at all — mirrors an older CLI / Codex-adjacent handle.
      return gen;
    },
  } as unknown as typeof import('@anthropic-ai/claude-agent-sdk');
  return sdk;
}

function runTurn(
  sdk: typeof import('@anthropic-ai/claude-agent-sdk'),
  events: EngineEvent[],
): ReturnType<EngineCore['run']> {
  const core = new EngineCore(sdk, {} as never, { homeRoot: HOME_ROOT });
  return core.run({
    engine: 'claude',
    task: 'say hi',
    cwd: '/tmp/wt',
    systemPrompt: 'persona',
    sandboxKey: TEST_KEY,
    mode: 'execute',
    auth: { secret: 'oauth-tok' },
    onEvent: (e: EngineEvent) => events.push(e),
  } as never);
}

describe('EngineCore — context breakdown capture', () => {
  it('emits a live context_breakdown event and lands the normalized breakdown on result.usage.contextBreakdown', async () => {
    const sdk = makeContextBreakdownFake(async function* () {
      yield initMsg();
      await tick();
      yield assistantWithUsage('hello');
      await tick();
      yield resultMsg('hello', 10, 5);
    }, 'resolve');
    const events: EngineEvent[] = [];
    const res = await runTurn(sdk, events);

    const breakdownEvents = events.filter((e) => e.kind === 'context_breakdown');
    expect(breakdownEvents.length).toBeGreaterThan(0);
    expect(
      (breakdownEvents[0] as { breakdown: ContextBreakdown }).breakdown,
    ).toEqual(EXPECTED_BREAKDOWN);
    expect(res.usage?.contextBreakdown).toEqual(EXPECTED_BREAKDOWN);
  });

  it('is a graceful no-op when getContextUsage is not a function on the handle (Codex / older CLI)', async () => {
    const sdk = makeContextBreakdownFake(async function* () {
      yield initMsg();
      await tick();
      yield assistantWithUsage('hello');
      await tick();
      yield resultMsg('hello', 10, 5);
    }, 'absent');
    const events: EngineEvent[] = [];
    const res = await runTurn(sdk, events);

    expect(res.result).toBe('hello');
    expect(events.some((e) => e.kind === 'context_breakdown')).toBe(false);
    expect(res.usage?.contextBreakdown).toBeUndefined();
  });

  it('does not throw into the turn when getContextUsage rejects', async () => {
    const sdk = makeContextBreakdownFake(async function* () {
      yield initMsg();
      await tick();
      yield assistantWithUsage('hello');
      await tick();
      yield resultMsg('hello', 10, 5);
    }, 'reject');
    const events: EngineEvent[] = [];
    const res = await runTurn(sdk, events);

    expect(res.result).toBe('hello');
    expect(events.some((e) => e.kind === 'context_breakdown')).toBe(false);
    expect(res.usage?.contextBreakdown).toBeUndefined();
  });
});
