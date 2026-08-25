import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { EngineCore } from './engine-core';
import type { EngineHomeKey } from './engine-home';

const HOME_ROOT = join(tmpdir(), `atlas-stream-closed-${process.pid}`);
afterAll(() => rmSync(HOME_ROOT, { recursive: true, force: true }));

const idleSteerInput: AsyncIterable<{ id?: string; text: string }> = {
  [Symbol.asyncIterator]() {
    return {
      next: () => new Promise<IteratorResult<{ id?: string; text: string }>>(() => {}),
    };
  },
};
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

type ResultFields = { terminal_reason?: string; stop_reason?: string | null };
type RunState = {
  inputClosedAt?: number;
  toolAttemptedAt?: number;
  inputClosedAtAttempt?: boolean;
};

function streamClosedSdk(resultFields: ResultFields, state: RunState) {
  return {
    query: ({ prompt }: { prompt: AsyncIterable<unknown>; options: Record<string, unknown> }) =>
      (async function* () {
        let inputClosed = false;
        const it = prompt[Symbol.asyncIterator]();
        void (async () => {
          while (true) {
            const r = await it.next();
            if (r.done) {
              inputClosed = true;
              state.inputClosedAt = Date.now();
              break;
            }
          }
        })();

        yield { type: 'system', subtype: 'init', session_id: 'sess-1' };
        await sleep(5);
        yield {
          type: 'assistant',
          message: {
            model: 'claude-opus-4-8',
            content: [{ type: 'text', text: 'Here is my recommendation.' }],
            usage: { input_tokens: 20_000 },
          },
        };
        await sleep(5);
        yield {
          type: 'result',
          subtype: 'success',
          session_id: 'sess-1',
          result: 'recommendation',
          usage: { input_tokens: 1, output_tokens: 1 },
          ...resultFields,
        };

        await sleep(STEER_GRACE_PAD);
        state.toolAttemptedAt = Date.now();
        state.inputClosedAtAttempt = inputClosed;
        const toolId = 'toolu_ask_1';
        yield {
          type: 'assistant',
          message: {
            model: 'claude-opus-4-8',
            content: [
              {
                type: 'tool_use',
                id: toolId,
                name: 'mcp__atlas-host-bridge__ask_question',
                input: { args: { header: 'Scope of the retract fix' } },
              },
            ],
            usage: { input_tokens: 20_100 },
          },
        };
        await sleep(5);
        yield {
          type: 'user',
          message: {
            content: [
              {
                type: 'tool_result',
                tool_use_id: toolId,
                is_error: inputClosed,
                content: inputClosed ? 'Stream closed' : 'ok',
              },
            ],
          },
        };
        await sleep(5);
        yield {
          type: 'result',
          subtype: 'success',
          session_id: 'sess-1',
          result: 'final',
          terminal_reason: 'completed',
          stop_reason: 'end_turn',
          usage: { input_tokens: 1, output_tokens: 1 },
        };
      })(),
  } as unknown as typeof import('@anthropic-ai/claude-agent-sdk');
}

const STEER_GRACE_PAD = 500;

type ToolResult = { id: string; isError?: boolean; result: unknown };

async function runTurn(
  resultFields: ResultFields,
): Promise<{ state: RunState; toolResults: ToolResult[] }> {
  const state: RunState = {};
  const toolResults: ToolResult[] = [];
  const core = new EngineCore(streamClosedSdk(resultFields, state), {} as never, {
    homeRoot: HOME_ROOT,
  });
  await core.run({
    engine: 'claude',
    task: 'trace the withdraw flow and post the scope card',
    cwd: '/tmp/wt',
    systemPrompt: 'persona',
    sandboxKey: {
      orgId: 'acme',
      repoId: 'atlas',
      jobId: 'feat',
      type: 'build',
    } as EngineHomeKey,
    mode: 'execute',
    richStream: true,
    auth: { secret: 'oauth-tok' },
    steerInput: idleSteerInput,
    onEvent: (e: { kind: string; id?: string; isError?: boolean; result?: unknown }) => {
      if (e.kind === 'tool_result')
        toolResults.push({
          id: e.id ?? '',
          isError: e.isError,
          result: e.result,
        });
    },
  } as never);
  return { state, toolResults };
}

describe('EngineCore — streaming input-close gated on a genuinely-completed result (d1)', () => {
  it('non-completed result (blocking_limit) keeps input OPEN → mid-turn host tool succeeds', async () => {
    const { state, toolResults } = await runTurn({
      terminal_reason: 'blocking_limit',
    });
    expect(state.inputClosedAtAttempt).toBe(false);
    expect(state.inputClosedAt!).toBeGreaterThan(state.toolAttemptedAt!);
    expect(toolResults).toHaveLength(1);
    expect(toolResults[0].isError).toBe(false);
    expect(String(toolResults[0].result)).not.toContain('Stream closed');
  });

  it('absent terminal_reason without an end_turn stop keeps input OPEN → host tool succeeds', async () => {
    const { state, toolResults } = await runTurn({ stop_reason: null });
    expect(state.inputClosedAtAttempt).toBe(false);
    expect(state.inputClosedAt!).toBeGreaterThan(state.toolAttemptedAt!);
    expect(toolResults).toHaveLength(1);
    expect(toolResults[0].isError).toBe(false);
  });

  it("completed result (terminal_reason:'completed', stop_reason:'end_turn') CLOSES input after the grace", async () => {
    const { state } = await runTurn({
      terminal_reason: 'completed',
      stop_reason: 'end_turn',
    });
    expect(state.inputClosedAtAttempt).toBe(true);
    expect(state.inputClosedAt).toBeDefined();
    expect(state.toolAttemptedAt).toBeDefined();
    expect(state.inputClosedAt!).toBeLessThan(state.toolAttemptedAt!);
  });

  it('absent terminal_reason + stop_reason:end_turn (CLI-drift fallback) CLOSES input', async () => {
    const { state } = await runTurn({ stop_reason: 'end_turn' });
    expect(state.inputClosedAtAttempt).toBe(true);
    expect(state.inputClosedAt).toBeDefined();
    expect(state.inputClosedAt!).toBeLessThan(state.toolAttemptedAt!);
  });
});

type CircuitState = { abortController?: AbortController };

function toolResultStreamSdk(
  results: Array<{ isError: boolean; content: unknown }>,
  emitFinalResult: boolean,
  state: CircuitState,
) {
  return {
    query: ({
      prompt,
      options,
    }: {
      prompt: AsyncIterable<unknown>;
      options: Record<string, unknown>;
    }) => {
      state.abortController = options.abortController as AbortController;
      return (async function* () {
        const it = prompt[Symbol.asyncIterator]();
        void (async () => {
          while (true) {
            const r = await it.next();
            if (r.done) break;
          }
        })();

        yield { type: 'system', subtype: 'init', session_id: 'sess-1' };
        await sleep(5);
        yield {
          type: 'assistant',
          message: {
            model: 'claude-opus-4-8',
            content: [{ type: 'text', text: 'working on it' }],
          },
        };
        await sleep(5);
        for (const r of results) {
          yield {
            type: 'user',
            message: {
              content: [
                {
                  type: 'tool_result',
                  tool_use_id: 'toolu_x',
                  is_error: r.isError,
                  content: r.content,
                },
              ],
            },
          };
          await sleep(5);
        }
        if (emitFinalResult) {
          yield {
            type: 'result',
            subtype: 'success',
            session_id: 'sess-1',
            result: 'final',
            terminal_reason: 'completed',
            stop_reason: 'end_turn',
            usage: { input_tokens: 1, output_tokens: 1 },
          };
        }
      })();
    },
  } as unknown as typeof import('@anthropic-ai/claude-agent-sdk');
}

const STREAM_CLOSED_TEXT = 'Tool permission request failed: Error: Stream closed';
const HEALTHY_TEXT = 'ok';

function runCircuitTurn(
  sdk: typeof import('@anthropic-ai/claude-agent-sdk'),
): ReturnType<EngineCore['run']> {
  const core = new EngineCore(sdk, {} as never, { homeRoot: HOME_ROOT });
  return core.run({
    engine: 'claude',
    task: 'post the scope card',
    cwd: '/tmp/wt',
    systemPrompt: 'persona',
    sandboxKey: {
      orgId: 'acme',
      repoId: 'atlas',
      jobId: 'feat',
      type: 'build',
    } as EngineHomeKey,
    mode: 'execute',
    richStream: true,
    auth: { secret: 'oauth-tok' },
    steerInput: idleSteerInput,
    onEvent: () => {},
  } as never);
}

describe('EngineCore — stream-closed circuit breaker (d1)', () => {
  const ORIG_THRESHOLD = process.env.ENGINE_STREAM_CLOSED_THRESHOLD;
  afterEach(() => {
    if (ORIG_THRESHOLD === undefined) delete process.env.ENGINE_STREAM_CLOSED_THRESHOLD;
    else process.env.ENGINE_STREAM_CLOSED_THRESHOLD = ORIG_THRESHOLD;
  });

  it('trips at the threshold: rejects the run and aborts the CLI child', async () => {
    process.env.ENGINE_STREAM_CLOSED_THRESHOLD = '3';
    const state: CircuitState = {};
    const sdk = toolResultStreamSdk(
      [
        { isError: true, content: STREAM_CLOSED_TEXT },
        { isError: true, content: STREAM_CLOSED_TEXT },
        { isError: true, content: STREAM_CLOSED_TEXT },
      ],
      false,
      state,
    );

    await expect(runCircuitTurn(sdk)).rejects.toThrow(/stream closed/i);
    expect(state.abortController?.signal.aborted).toBe(true);
  });

  it('a healthy result resets the consecutive run: an isolated blip never trips the breaker', async () => {
    process.env.ENGINE_STREAM_CLOSED_THRESHOLD = '3';
    const state: CircuitState = {};
    const sdk = toolResultStreamSdk(
      [
        {
          isError: true,
          content: [{ type: 'text', text: STREAM_CLOSED_TEXT.toLowerCase() }],
        }, // run: 1
        { isError: false, content: HEALTHY_TEXT }, // resets the run to 0
        { isError: true, content: STREAM_CLOSED_TEXT }, // run: 1
        { isError: true, content: STREAM_CLOSED_TEXT }, // run: 2 — never reaches the threshold of 3
      ],
      true,
      state,
    );

    const res = await runCircuitTurn(sdk);
    expect(res.streamClosedCount).toBe(3);
  });
});
