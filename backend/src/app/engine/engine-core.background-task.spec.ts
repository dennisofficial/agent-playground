/**
 * Regression test for the `run_in_background` Bash "the SDK kills the still-running shell" fix. A tool-native
 * background task closes the turn's FIRST `result` immediately (terminal_reason=completed), which — without
 * this fix — let the post-result grace close the streaming input and force the SDK to kill the live shell.
 * The engine now HOLDS the query() session open while any background task is in flight (gated on the
 * task_started/task_notification pair, NOT the result), so the task's completion AND the model's
 * auto-continuation arrive in the SAME turn. The hold is bounded by BG_TASK_MAX_HOLD_MS; on the cap the agent
 * is steered with BG_TASK_CAP_NOTICE and given BG_TASK_CAP_ACK_GRACE_MS to ack before an unconditional close.
 *
 * These three tests drive a fake SDK whose generator scripts the exact system/assistant/result frames and
 * whose single drain loop records both engine-injected steers (`pushed`) and whether `input.end()` fired
 * (`state.inputEnded`) — the observable proof of hold, cap-with-ack, and cap-backstop.
 *
 * BG_TASK_MAX_HOLD_MS is gone (d4): the hold cap now comes LIVE from the `bg-task-cap` JIT rule's
 * `trigger.holdMs`, so a test that needs a small cap mutates the rule directly (restored in `afterEach`).
 */
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync } from 'node:fs';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { bgTaskCapRule } from '../prompt-kit/jit';
import { EngineCore } from './engine-core';
import { type EngineHomeKey } from './engine-home';
import { BG_TASK_CAP_NOTICE, type EngineEvent } from './engine.types';

const TEST_KEY: EngineHomeKey = { orgId: 'acme', repoId: 'atlas', jobId: 'feat', type: 'build' };

const HOME_ROOT = join(tmpdir(), `atlas-bg-task-${process.pid}`);
afterAll(() => rmSync(HOME_ROOT, { recursive: true, force: true }));

/** A steerInput that never yields — it just flips the engine into streaming-input mode so `input` exists. */
const idleSteerInput: AsyncIterable<{ id?: string; text: string }> = {
  [Symbol.asyncIterator]() {
    return { next: () => new Promise<IteratorResult<{ id?: string; text: string }>>(() => {}) };
  },
};

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 5));
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// ── Scripted SDK frames (only the fields the engine reads; shapes mirror @anthropic-ai/claude-agent-sdk). ──
const initMsg = (): Record<string, unknown> => ({ type: 'system', subtype: 'init', session_id: 'sess-1' });
const assistantBash = (): Record<string, unknown> => ({
  type: 'assistant',
  message: { model: 'opus', content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'pnpm test', run_in_background: true } }] },
});
const assistantText = (text: string): Record<string, unknown> => ({
  type: 'assistant',
  message: { model: 'opus', content: [{ type: 'text', text }] },
});
const taskStarted = (taskId: string): Record<string, unknown> => ({
  type: 'system', subtype: 'task_started', task_id: taskId, description: 'pnpm test', task_type: 'bash', session_id: 'sess-1',
});
const taskNotification = (taskId: string, status: string, summary: string): Record<string, unknown> => ({
  type: 'system', subtype: 'task_notification', task_id: taskId, status, summary, output_file: '/tmp/out.log', session_id: 'sess-1',
});
const taskUpdated = (taskId: string, status: string): Record<string, unknown> => ({
  type: 'system', subtype: 'task_updated', task_id: taskId, patch: { status }, session_id: 'sess-1',
});
const taskProgress = (taskId: string): Record<string, unknown> => ({
  type: 'system', subtype: 'task_progress', task_id: taskId, description: 'running', usage: { total_tokens: 1, tool_uses: 0, duration_ms: 1 }, session_id: 'sess-1',
});
// A genuinely-completed result — for a tool-native run_in_background, the SDK's first result carries
// terminal_reason 'completed' (verified live against sdk 0.3.201), so isTurnGenuinelyDone() is true and the
// engine reaches the background-task hold/cap gate rather than the paused-result keep-open branch (#65).
const resultMsg = (result: string, inputTokens: number, outputTokens: number): Record<string, unknown> => ({
  type: 'result', subtype: 'success', session_id: 'sess-1', result, terminal_reason: 'completed', stop_reason: 'end_turn', usage: { input_tokens: inputTokens, output_tokens: outputTokens },
});

type FakeState = { inputEnded: boolean };

/**
 * A fake SDK whose `query` yields the scripted frames while a SINGLE background loop drains its own input
 * stream: the initial task push is skipped, every subsequent push (an engine-injected steer, e.g. the cap
 * notice) is recorded into `pushed`, and `input.end()` (the stream terminating) flips `state.inputEnded`.
 */
function makeSteerFake(
  script: (state: FakeState) => AsyncGenerator<Record<string, unknown>>,
): { sdk: typeof import('@anthropic-ai/claude-agent-sdk'); pushed: string[]; state: FakeState } {
  const pushed: string[] = [];
  const state: FakeState = { inputEnded: false };
  const sdk = {
    query: ({ prompt }: { prompt: AsyncIterable<unknown>; options: Record<string, unknown> }) =>
      (async function* () {
        const it = prompt[Symbol.asyncIterator]();
        let taskSeen = false;
        void (async () => {
          while (true) {
            const r = await it.next();
            if (r.done) {
              state.inputEnded = true;
              break;
            }
            if (!taskSeen) {
              taskSeen = true; // the initial task push
              continue;
            }
            const content = (r.value as { message?: { content?: unknown } }).message?.content;
            pushed.push(typeof content === 'string' ? content : JSON.stringify(content));
          }
        })();
        yield* script(state);
      })(),
  } as unknown as typeof import('@anthropic-ai/claude-agent-sdk');
  return { sdk, pushed, state };
}

function runTurn(
  sdk: typeof import('@anthropic-ai/claude-agent-sdk'),
  events: EngineEvent[],
): ReturnType<EngineCore['run']> {
  const core = new EngineCore(sdk, {} as never, { homeRoot: HOME_ROOT });
  return core.run({
    engine: 'claude',
    task: 'run the suite in the background',
    cwd: '/tmp/wt',
    systemPrompt: 'persona',
    sandboxKey: TEST_KEY,
    mode: 'execute',
    auth: { secret: 'oauth-tok' },
    steerInput: idleSteerInput,
    onEvent: (e: EngineEvent) => events.push(e),
  } as never);
}

const holdTrigger = bgTaskCapRule.trigger as { holdMs: number };
const ORIG_HOLD_MS = holdTrigger.holdMs;
const ORIG_ENABLED = bgTaskCapRule.enabled;
const ORIG_GRACE = process.env.BG_TASK_CAP_ACK_GRACE_MS;
const restoreEnv = (key: string, value: string | undefined): void => {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
};
afterEach(() => {
  holdTrigger.holdMs = ORIG_HOLD_MS;
  bgTaskCapRule.enabled = ORIG_ENABLED;
  restoreEnv('BG_TASK_CAP_ACK_GRACE_MS', ORIG_GRACE);
});

describe('EngineCore — run_in_background hold + cap', () => {
  it('holds the turn open until the task settles, captures the auto-continuation, and sums usage across results', async () => {
    holdTrigger.holdMs = 600_000; // large — the cap must never fire here
    process.env.BG_TASK_CAP_ACK_GRACE_MS = '15000';
    let heldWhileRunning = false;
    const { sdk, pushed } = makeSteerFake(async function* (state) {
      yield initMsg();
      await tick();
      yield assistantBash();
      await tick();
      yield taskStarted('X');
      await tick();
      yield resultMsg('first', 10, 5); // the immediate tool-native first result
      await tick();
      await tick();
      heldWhileRunning = !state.inputEnded; // input still open while the task is in flight
      yield taskNotification('X', 'completed', 'done');
      await tick();
      yield assistantText('ACKED');
      await tick();
      yield resultMsg('ACKED', 20, 7); // the model's auto-continuation, same turn
      await tick();
    });
    const events: EngineEvent[] = [];
    const res = await runTurn(sdk, events);

    expect(heldWhileRunning).toBe(true);
    expect(res.result).toBe('ACKED');
    expect(res.usage?.inputTokens).toBe(30);
    expect(res.usage?.outputTokens).toBe(12);
    expect(pushed).toEqual([]); // nothing steered on the happy path
    expect(events.some((e) => e.kind === 'bg_task' && e.status === 'started')).toBe(true);
    expect(events.some((e) => e.kind === 'bg_task' && e.status === 'capped')).toBe(false);
  });

  it('caps a stuck task, steers the agent with the cap notice, and closes directly when the agent acks', async () => {
    holdTrigger.holdMs = 50;
    process.env.BG_TASK_CAP_ACK_GRACE_MS = '500';
    let endedAfterAck = false;
    const { sdk, pushed } = makeSteerFake(async function* (state) {
      yield initMsg();
      await tick();
      yield assistantBash();
      await tick();
      yield taskStarted('X');
      await tick();
      yield resultMsg('first', 10, 5);
      await sleep(120); // > HOLD_CAP_MS with NO task_notification → onCap fires
      yield taskUpdated('X', 'running'); // a late frame — must NOT undo the forced close
      await tick();
      yield resultMsg('ACKED', 20, 7); // the agent acked the cap notice
      await tick();
      endedAfterAck = state.inputEnded;
    });
    const events: EngineEvent[] = [];
    await runTurn(sdk, events);

    expect(pushed).toContain(BG_TASK_CAP_NOTICE);
    expect(events.some((e) => e.kind === 'bg_task' && e.status === 'capped')).toBe(true);
    expect(endedAfterAck).toBe(true); // the ack result closed input directly (past the `!capping` guard)
  });

  it('caps a stuck task and unconditionally closes after the ack grace when the agent never acks', async () => {
    holdTrigger.holdMs = 50;
    process.env.BG_TASK_CAP_ACK_GRACE_MS = '150';
    let endedByBackstop = false;
    const { sdk, pushed } = makeSteerFake(async function* (state) {
      yield initMsg();
      await tick();
      yield assistantBash();
      await tick();
      yield taskStarted('X');
      await tick();
      yield resultMsg('first', 10, 5);
      await sleep(80); // > HOLD_CAP_MS → onCap fires, arms the ack-grace backstop
      yield taskProgress('X');
      await sleep(60);
      yield taskProgress('X'); // only progress, never a result to ack
      await sleep(200); // > CAP_ACK_GRACE_MS from the cap → the backstop closes input
      endedByBackstop = state.inputEnded;
    });
    const events: EngineEvent[] = [];
    await runTurn(sdk, events);

    expect(pushed).toContain(BG_TASK_CAP_NOTICE);
    expect(endedByBackstop).toBe(true); // the unconditional backstop bounded the hold
  });

  it('honors bg-task-cap.enabled=false by capping without injecting the JIT notice', async () => {
    holdTrigger.holdMs = 50;
    bgTaskCapRule.enabled = false;
    process.env.BG_TASK_CAP_ACK_GRACE_MS = '100';
    let endedByBackstop = false;
    const { sdk, pushed } = makeSteerFake(async function* (state) {
      yield initMsg();
      await tick();
      yield assistantBash();
      await tick();
      yield taskStarted('X');
      await tick();
      yield resultMsg('first', 10, 5);
      await sleep(80); // > HOLD_CAP_MS → cap fires, but the disabled rule emits no prompt text
      yield taskProgress('X');
      await sleep(150); // > CAP_ACK_GRACE_MS from the cap → the backstop closes input
      endedByBackstop = state.inputEnded;
    });
    const events: EngineEvent[] = [];
    await runTurn(sdk, events);

    expect(pushed).not.toContain(BG_TASK_CAP_NOTICE);
    expect(events.some((e) => e.kind === 'bg_task' && e.status === 'capped')).toBe(true);
    expect(endedByBackstop).toBe(true);
  });
});
