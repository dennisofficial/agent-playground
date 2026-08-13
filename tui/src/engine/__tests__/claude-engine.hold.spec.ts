import { describe, expect, it } from 'bun:test';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import type { EngineEvent } from '../../domain/message.js';
import { ClaudeEngineService, type RunResult } from '../claude-engine.service.js';
import type { ClaudeAgentSdk } from '../claude-sdk.provider.js';
import { ClaudeNormaliserService } from '../normalise/claude-normaliser.service.js';
import { MessageQueue } from '../message-queue.js';
import type { RawTapeService } from '../raw-tape.service.js';
import {
  result,
  taskNotification,
  taskStarted,
} from '../normalise/__tests__/scripted-turn.fixture.js';

/**
 * The turn does not end when the model stops talking — it ends when the work it spawned settles.
 *
 * A backgrounded delegate outlives the frame that launched it, and closing the stream at `result` takes
 * the CLI process and the delegate with it. That failure is written into Atlas's own tapes: a later
 * session opened to `task_notification status: "stopped"` and *"No completion record was found for
 * background agent … it may have been running when the previous Claude Code process exited"*.
 *
 * Driven through the real drain loop with a hand-fed SDK, because the bug was never in the rule — it
 * was in `break`.
 */

/** An SDK stand-in whose frames this test pushes one at a time. */
function fakeSdk(): {
  sdk: ClaudeAgentSdk;
  emit: (message: SDKMessage) => void;
  finish: () => void;
} {
  const frames = new MessageQueue<SDKMessage>();
  const sdk = {
    query: () =>
      Object.assign(frames[Symbol.asyncIterator](), {
        interrupt: async () => undefined,
      }),
  } as unknown as ClaudeAgentSdk;
  return {
    sdk,
    emit: (message) => frames.push(message),
    finish: () => frames.close(),
  };
}

const TAPE = { append: () => undefined } as unknown as RawTapeService;

function start(sdk: ClaudeAgentSdk): {
  done: Promise<RunResult>;
  events: EngineEvent[];
  holds: boolean[];
} {
  const events: EngineEvent[] = [];
  const holds: boolean[] = [];
  const engine = new ClaudeEngineService(sdk, new ClaudeNormaliserService(), TAPE);
  const turn = engine.start({
    prompt: 'go',
    cwd: '/repo',
    model: 'claude-opus-5',
    env: {},
    onEvent: (event) => events.push(event),
    onHold: (holding) => holds.push(holding),
  });
  return { done: turn.done, events, holds };
}

/** Let the drain loop run to wherever it is going to block. */
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 5));

/** Resolved, or still pending? The whole question this file asks. */
async function isPending(promise: Promise<unknown>): Promise<boolean> {
  const marker = Symbol('pending');
  const race = await Promise.race([promise, Promise.resolve(marker)]);
  return race === marker;
}

describe('a turn that spawned background work', () => {
  it('ends at `result` when it spawned nothing — the ordinary turn is unchanged', async () => {
    const { sdk, emit, finish } = fakeSdk();
    const turn = start(sdk);
    emit(result('done'));
    await settle();

    expect(await isPending(turn.done)).toBe(false);
    finish();
    expect((await turn.done).ok).toBe(true);
  });

  it('stays open past `result` while a subagent is still running, and ends when it settles', async () => {
    const { sdk, emit, finish } = fakeSdk();
    const turn = start(sdk);

    emit(taskStarted());
    emit(result('launched'));
    await settle();

    // The turn is NOT over. Ending here is what killed the delegate: the session closes, the CLI
    // process exits, and the notification is delivered to nobody.
    expect(await isPending(turn.done)).toBe(true);
    expect(turn.holds).toEqual([true]);

    // The delegate settles — which is the whole point of staying open, because this frame is what
    // wakes the model — and the model's next result closes the turn for real.
    emit(taskNotification());
    emit(result('read the report'));
    await settle();

    expect(await isPending(turn.done)).toBe(false);
    // The hold lifted the moment the session was in use again, before the turn ended.
    expect(turn.holds).toEqual([true, false]);
    finish();
  });

  it('reports the delegate through to its caller rather than swallowing it', async () => {
    const { sdk, emit, finish } = fakeSdk();
    const turn = start(sdk);
    emit(taskStarted());
    emit(result('launched'));
    await settle();
    emit(taskNotification());
    emit(result('done'));
    await settle();
    finish();
    await turn.done;

    expect(turn.events.map((event) => event.kind)).toContain('task_started');
    expect(turn.events.map((event) => event.kind)).toContain('task_settled');
  });

  it('lets the stream ending close a held turn, so a crashed CLI cannot hang it forever', async () => {
    const { sdk, emit, finish } = fakeSdk();
    const turn = start(sdk);
    emit(taskStarted());
    emit(result('launched'));
    await settle();
    expect(await isPending(turn.done)).toBe(true);

    finish();
    await settle();
    expect(await isPending(turn.done)).toBe(false);
  });
});
