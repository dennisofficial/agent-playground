/**
 * Regression for the "Stream closed" host-tool failure (prod incident b30616d2). Drives the REAL
 * EngineCore streaming-input lifecycle with a fake SDK that models the bundled CLI faithfully:
 *   - it CONSUMES the engine's manual `input` stream in the background and records the instant the engine
 *     calls `input.end()` (→ the CLI's stdin EOF → input closed);
 *   - it emits ONE success `result` mid-turn with a scripted `terminal_reason` / `stop_reason`, then waits
 *     past STEER_IDLE_GRACE_MS and attempts a host-tool call, returning the tool_result as
 *     `is_error:'Stream closed'` iff input was already closed at call time — exactly like the CLI's
 *     control-request client.
 *
 * The fix (decision d1): the engine arms the end-of-turn close ONLY on a genuinely-completed result
 * (`terminal_reason:'completed'`, or absent + `stop_reason:'end_turn'`). A paused/interrupted success
 * result (rate-limit / retry / budget) keeps input OPEN so the pending host-tool call still succeeds.
 */
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync } from 'node:fs';
import { afterAll, describe, expect, it } from 'vitest';
import { EngineCore } from './engine-core';
import type { EngineHomeKey } from './engine-home';

const HOME_ROOT = join(tmpdir(), `atlas-stream-closed-${process.pid}`);
afterAll(() => rmSync(HOME_ROOT, { recursive: true, force: true }));

/** A steerInput that never yields — it only flips the engine into streaming-input mode so `input` exists. */
const idleSteerInput: AsyncIterable<{ id?: string; text: string }> = {
  [Symbol.asyncIterator]() {
    return { next: () => new Promise<IteratorResult<{ id?: string; text: string }>>(() => {}) };
  },
};
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

type ResultFields = { terminal_reason?: string; stop_reason?: string | null };
type RunState = { inputClosedAt?: number; toolAttemptedAt?: number; inputClosedAtAttempt?: boolean };

/**
 * Faithful CLI stand-in. Emits one success `result` carrying `resultFields`, then — after a pause LONGER
 * than the grace window — attempts a host-tool call. `state` is shared so the test can observe whether the
 * engine had closed input by the time the host tool was invoked.
 */
function streamClosedSdk(resultFields: ResultFields, state: RunState) {
  return {
    query: ({ prompt }: { prompt: AsyncIterable<unknown>; options: Record<string, unknown> }) =>
      (async function* () {
        // Background: drain the engine's manual input stream; note when it ENDS (input.end()).
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
          message: { model: 'claude-opus-4-8', content: [{ type: 'text', text: 'Here is my recommendation.' }], usage: { input_tokens: 20_000 } },
        };
        await sleep(5);
        // The success result under test. Its terminal_reason/stop_reason decide whether the engine closes.
        yield { type: 'result', subtype: 'success', session_id: 'sess-1', result: 'recommendation', usage: { input_tokens: 1, output_tokens: 1 }, ...resultFields };

        // Pause LONGER than the 350ms grace (the incident had 70s gaps under heavy throttling), then try the
        // host-tool call. If the engine closed input during the pause, the control round-trip can't complete.
        await sleep(STEER_GRACE_PAD);
        state.toolAttemptedAt = Date.now();
        state.inputClosedAtAttempt = inputClosed;
        const toolId = 'toolu_ask_1';
        yield {
          type: 'assistant',
          message: { model: 'claude-opus-4-8', content: [{ type: 'tool_use', id: toolId, name: 'mcp__atlas-host-bridge__ask_question', input: { args: { header: 'Scope of the retract fix' } } }], usage: { input_tokens: 20_100 } },
        };
        await sleep(5);
        yield {
          type: 'user',
          message: { content: [{ type: 'tool_result', tool_use_id: toolId, is_error: inputClosed, content: inputClosed ? 'Stream closed' : 'ok' }] },
        };
        await sleep(5);
        // The turn genuinely finishes now — the generator returns, ending the run.
        yield { type: 'result', subtype: 'success', session_id: 'sess-1', result: 'final', terminal_reason: 'completed', stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } };
      })(),
  } as unknown as typeof import('@anthropic-ai/claude-agent-sdk');
}

// Well past STEER_IDLE_GRACE_MS (350) so a scheduled close would definitely have fired before the tool call.
const STEER_GRACE_PAD = 500;

type ToolResult = { id: string; isError?: boolean; result: unknown };

async function runTurn(resultFields: ResultFields): Promise<{ state: RunState; toolResults: ToolResult[] }> {
  const state: RunState = {};
  const toolResults: ToolResult[] = [];
  const core = new EngineCore(streamClosedSdk(resultFields, state), {} as never, { homeRoot: HOME_ROOT });
  await core.run({
    engine: 'claude',
    task: 'trace the withdraw flow and post the scope card',
    cwd: '/tmp/wt',
    systemPrompt: 'persona',
    sandboxKey: { orgId: 'acme', repoId: 'atlas', jobId: 'feat', type: 'build' } as EngineHomeKey,
    mode: 'execute',
    richStream: true,
    auth: { secret: 'oauth-tok' },
    steerInput: idleSteerInput,
    onEvent: (e: { kind: string; id?: string; isError?: boolean; result?: unknown }) => {
      if (e.kind === 'tool_result') toolResults.push({ id: e.id ?? '', isError: e.isError, result: e.result });
    },
  } as never);
  return { state, toolResults };
}

describe('EngineCore — streaming input-close gated on a genuinely-completed result (d1)', () => {
  it('non-completed result (blocking_limit) keeps input OPEN → mid-turn host tool succeeds', async () => {
    const { state, toolResults } = await runTurn({ terminal_reason: 'blocking_limit' });
    expect(state.inputClosedAtAttempt).toBe(false);
    // Input closes only during normal teardown (the finally block), strictly AFTER the host tool ran.
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
    const { state } = await runTurn({ terminal_reason: 'completed', stop_reason: 'end_turn' });
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
