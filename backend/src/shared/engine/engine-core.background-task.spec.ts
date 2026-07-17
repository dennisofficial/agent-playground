/**
 * Regression test for the `run_in_background` Bash "the SDK kills the still-running shell" fix, and for the
 * follow-up decision (d3) that made the hold cap purely ADVISORY. A tool-native background task closes the
 * turn's FIRST `result` immediately (terminal_reason=completed), which — without the hold — would let the
 * post-result grace close the streaming input and force the SDK to kill the live shell. The engine instead
 * HOLDS the query() session open while any background task is in flight (gated on the task_started/
 * task_notification pair, NOT the result), so the task's completion AND the model's auto-continuation arrive
 * in the SAME turn.
 *
 * d3 — the hold cap NEVER severs the stream:
 *   - a live background SUBAGENT (task_started carrying `subagent_type`) runs UNCAPPED — held open with NO
 *     timer at all, since a subagent may run for hours; bounded only by the outer PHASE_TIMEOUT / an operator
 *     Stop. `input.end()` is never called as a cap reaction for it.
 *   - a bare backgrounded Bash shell (no `subagent_type`) that outlives the hold is capped ADVISORY-only: the
 *     agent gets a `bg_task` `status:'capped'` event and (if the rule is enabled) the `BG_TASK_CAP_NOTICE`
 *     steer, but stdin is NEVER closed by the cap. The turn ends only when the model's next natural result
 *     lands (the normal post-result grace) or via the outer PHASE_TIMEOUT.
 * The old `capKillTimer` / unconditional `input.end()` / `BG_TASK_CAP_ACK_GRACE_MS` ack-then-close /
 * backstop-close are GONE — closing stdin under a still-active turn made every subsequent host-tool call
 * throw a bare "Stream closed" (prod incident b30616d2).
 *
 * These tests drive a fake SDK whose generator scripts the exact system/assistant/result frames and whose
 * single drain loop records both engine-injected steers (`pushed`) and whether `input.end()` fired
 * (`state.inputEnded`) — the observable proof of hold vs. advisory-cap-without-closing.
 *
 * The hold cap comes LIVE from the `bg-task-cap` JIT rule's `trigger.holdMs` (d4), so a test that needs a
 * small cap mutates the rule directly (restored in `afterEach`).
 */
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { bgTaskCapRule } from '../prompt-kit/jit';
import { EngineCore } from './engine-core';
import { type EngineHomeKey } from './engine-home';
import { BG_TASK_CAP_NOTICE, type EngineEvent } from './engine.types';

const TEST_KEY: EngineHomeKey = {
  orgId: 'acme',
  repoId: 'atlas',
  jobId: 'feat',
  type: 'build',
};

const HOME_ROOT = join(tmpdir(), `atlas-bg-task-${process.pid}`);
afterAll(() => rmSync(HOME_ROOT, { recursive: true, force: true }));

/** A steerInput that never yields — it just flips the engine into streaming-input mode so `input` exists. */
const idleSteerInput: AsyncIterable<{ id?: string; text: string }> = {
  [Symbol.asyncIterator]() {
    return {
      next: () => new Promise<IteratorResult<{ id?: string; text: string }>>(() => {}),
    };
  },
};

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 5));
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// ── Scripted SDK frames (only the fields the engine reads; shapes mirror @anthropic-ai/claude-agent-sdk). ──
const initMsg = (): Record<string, unknown> => ({
  type: 'system',
  subtype: 'init',
  session_id: 'sess-1',
});
const assistantBash = (): Record<string, unknown> => ({
  type: 'assistant',
  message: {
    model: 'opus',
    content: [
      {
        type: 'tool_use',
        id: 't1',
        name: 'Bash',
        input: { command: 'pnpm test', run_in_background: true },
      },
    ],
  },
});
const assistantText = (text: string): Record<string, unknown> => ({
  type: 'assistant',
  message: { model: 'opus', content: [{ type: 'text', text }] },
});
// A bare backgrounded Bash shell — no `subagent_type`, so the engine tracks it only in `liveBgTasks` and it
// is subject to the advisory hold cap.
const taskStarted = (taskId: string): Record<string, unknown> => ({
  type: 'system',
  subtype: 'task_started',
  task_id: taskId,
  description: 'pnpm test',
  task_type: 'bash',
  session_id: 'sess-1',
});
// A backgrounded Task subagent — carries `subagent_type`, so the engine also tracks it in `liveSubagentTasks`
// and holds it open with NO timer (uncapped).
const taskStartedSubagent = (taskId: string): Record<string, unknown> => ({
  type: 'system',
  subtype: 'task_started',
  task_id: taskId,
  description: 'validate',
  subagent_type: 'general-purpose',
  task_type: 'local_agent',
  session_id: 'sess-1',
});
const taskNotification = (
  taskId: string,
  status: string,
  summary: string,
): Record<string, unknown> => ({
  type: 'system',
  subtype: 'task_notification',
  task_id: taskId,
  status,
  summary,
  output_file: '/tmp/out.log',
  session_id: 'sess-1',
});
const taskUpdated = (taskId: string, status: string): Record<string, unknown> => ({
  type: 'system',
  subtype: 'task_updated',
  task_id: taskId,
  patch: { status },
  session_id: 'sess-1',
});
const taskProgress = (taskId: string): Record<string, unknown> => ({
  type: 'system',
  subtype: 'task_progress',
  task_id: taskId,
  description: 'running',
  usage: { total_tokens: 1, tool_uses: 0, duration_ms: 1 },
  session_id: 'sess-1',
});
// A genuinely-completed result — for a tool-native run_in_background, the SDK's first result carries
// terminal_reason 'completed' (verified live against sdk 0.3.201), so isTurnGenuinelyDone() is true and the
// engine reaches the background-task hold/cap gate rather than the paused-result keep-open branch (#65).
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

type FakeState = { inputEnded: boolean };

/**
 * A fake SDK whose `query` yields the scripted frames while a SINGLE background loop drains its own input
 * stream: the initial task push is skipped, every subsequent push (an engine-injected steer, e.g. the cap
 * notice) is recorded into `pushed`, and `input.end()` (the stream terminating) flips `state.inputEnded`.
 */
function makeSteerFake(script: (state: FakeState) => AsyncGenerator<Record<string, unknown>>): {
  sdk: typeof import('@anthropic-ai/claude-agent-sdk');
  pushed: string[];
  state: FakeState;
} {
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
afterEach(() => {
  holdTrigger.holdMs = ORIG_HOLD_MS;
  bgTaskCapRule.enabled = ORIG_ENABLED;
});

describe('EngineCore — run_in_background hold + cap', () => {
  it('holds the turn open until the task settles, captures the auto-continuation, and sums usage across results', async () => {
    holdTrigger.holdMs = 600_000; // large — the cap must never fire here
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

  it('a live background SUBAGENT is uncapped: input never closes and no cap fires while it runs', async () => {
    holdTrigger.holdMs = 30; // small — would trip a bare bg Bash almost immediately
    let stillOpenPastHold = false;
    const { sdk, pushed } = makeSteerFake(async function* (state) {
      yield initMsg();
      await tick();
      yield assistantBash();
      await tick();
      yield taskStartedSubagent('S');
      await tick();
      yield resultMsg('first', 10, 5); // the immediate tool-native first result
      await sleep(120); // well past holdMs, with NO task_notification — a bare bg Bash would have capped by now
      stillOpenPastHold = !state.inputEnded;
      yield taskNotification('S', 'completed', 'validated');
      await tick();
      yield assistantText('done validating');
      await tick();
      yield resultMsg('done', 20, 7); // the model's auto-continuation, same turn — settles the subagent + ends the turn
      await tick();
    });
    const events: EngineEvent[] = [];
    await runTurn(sdk, events);

    expect(stillOpenPastHold).toBe(true); // NO timer holds a live subagent — never capped
    expect(pushed).toEqual([]); // onCap bails while a subagent is live: no advisory nudge either
    expect(events.some((e) => e.kind === 'bg_task' && e.status === 'capped')).toBe(false);
  });

  it('a bare backgrounded Bash shell gets the advisory cap nudge, but the cap never force-closes input', async () => {
    holdTrigger.holdMs = 30;
    bgTaskCapRule.enabled = true;
    let cappedButOpen = false;
    const { sdk, pushed } = makeSteerFake(async function* (state) {
      yield initMsg();
      await tick();
      yield assistantBash();
      await tick();
      yield taskStarted('X'); // bare Bash — no subagent_type
      await tick();
      yield resultMsg('first', 10, 5);
      await sleep(120); // > holdMs with NO task_notification → onCap fires
      cappedButOpen = !state.inputEnded; // core d3 assertion: the cap fired but stdin is still open
      yield resultMsg('done', 20, 7); // the model's NEXT natural result — the normal grace now closes the turn
      await tick();
      await tick();
    });
    const events: EngineEvent[] = [];
    await runTurn(sdk, events);

    expect(pushed).toContain(BG_TASK_CAP_NOTICE);
    expect(events.some((e) => e.kind === 'bg_task' && e.status === 'capped')).toBe(true);
    expect(cappedButOpen).toBe(true); // no code path calls input.end() as a direct cap reaction
  });

  it('an advisory-capped Bash shell does not close the turn over a subsequently live subagent', async () => {
    holdTrigger.holdMs = 30;
    bgTaskCapRule.enabled = true;
    let subagentStillOpenPastGrace = false;
    const { sdk, pushed } = makeSteerFake(async function* (state) {
      yield initMsg();
      await tick();
      yield assistantBash();
      await tick();
      yield taskStarted('X'); // bare Bash — this is what triggers the advisory cap
      await tick();
      yield resultMsg('first', 10, 5);
      await sleep(120); // > holdMs: capping is now true, but stdin must still be open
      yield taskStartedSubagent('S');
      await tick();
      yield resultMsg('subagent launched', 11, 5);
      await sleep(450); // > STEER_IDLE_GRACE_MS: old capping branch would have closed stdin here
      subagentStillOpenPastGrace = !state.inputEnded;
      yield taskNotification('S', 'completed', 'validated');
      await tick();
      yield resultMsg('done', 20, 7);
      await tick();
      await tick();
    });
    const events: EngineEvent[] = [];
    await runTurn(sdk, events);

    expect(pushed).toContain(BG_TASK_CAP_NOTICE);
    expect(events.some((e) => e.kind === 'bg_task' && e.status === 'capped')).toBe(true);
    expect(subagentStillOpenPastGrace).toBe(true);
  });

  it('honors bg-task-cap.enabled=false by capping without injecting the notice, still never force-closing input', async () => {
    holdTrigger.holdMs = 30;
    bgTaskCapRule.enabled = false;
    let cappedButOpen = false;
    const { sdk, pushed } = makeSteerFake(async function* (state) {
      yield initMsg();
      await tick();
      yield assistantBash();
      await tick();
      yield taskStarted('X');
      await tick();
      yield resultMsg('first', 10, 5);
      await sleep(120); // > holdMs → cap fires, but the disabled rule emits no prompt text
      cappedButOpen = !state.inputEnded;
      yield resultMsg('done', 20, 7);
      await tick();
      await tick();
    });
    const events: EngineEvent[] = [];
    await runTurn(sdk, events);

    expect(pushed).not.toContain(BG_TASK_CAP_NOTICE);
    expect(events.some((e) => e.kind === 'bg_task' && e.status === 'capped')).toBe(true);
    expect(cappedButOpen).toBe(true);
  });
});
