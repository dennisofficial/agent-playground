import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import type { EngineEvent } from '../../domain/message.js';
import { ClaudeEngineService, type RunResult } from '../claude-engine.service.js';
import type { ClaudeAgentSdk } from '../claude-sdk.provider.js';
import { ClaudeNormaliserService } from '../normalise/claude-normaliser.service.js';
import { MessageQueue } from '../message-queue.js';
import type { RawTapeService } from '../raw-tape.service.js';
import { result } from '../normalise/__tests__/scripted-turn.fixture.js';

/**
 * The hand-fed SDK the hold tests are driven through, and the four helpers for asking a turn what it
 * is doing.
 *
 * Shared rather than duplicated because the CLI-shaped details in `fakeSdk` are load-bearing and easy
 * to get subtly wrong: the 50 ms exit delay is the only reason the steer-ordering assertions can fail
 * at all, and a stand-in that exits in the same microtask hid that bug from the first version of these
 * tests. One copy, so a second spec file cannot quietly weaken it.
 */

/**
 * The degenerate frame off the probe tape: a notification was delivered and consumed, the sampling
 * loop was never entered, and nothing was produced. `terminal_reason` and `stop_reason` null,
 * `num_turns` 0, all-zero usage, and an `origin` — the last of which is the only thing separating it
 * from a local slash command's result.
 */
export function wakeUp(): SDKMessage {
  return result('', false, {
    terminal_reason: null,
    stop_reason: null,
    num_turns: 0,
    origin: { kind: 'task-notification' },
    usage: { input_tokens: 0, output_tokens: 0 },
  });
}

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

/**
 * An SDK stand-in whose frames this test pushes one at a time.
 *
 * It also models the half of the contract that matters most here: the CLI reads its input off stdin,
 * and closing that input is what makes it exit and reap its own task groups. So the stand-in drains
 * the prompt iterable and ends its own stream when that iterable completes. Without this a test
 * cannot tell "the loop ended the turn" apart from "the loop hung", because every terminator in the
 * drain loop — the ordinary `break`, and the grace timer — goes through `input.close()`.
 */
export function fakeSdk(): {
  sdk: ClaudeAgentSdk;
  emit: (message: SDKMessage) => void;
  finish: () => void;
  /** How many cooperative interrupts the CLI was asked for — esc's first stage, and only that one. */
  interrupts: () => number;
  /** What was written INTO the session after the opening prompt — the cap's steer, and only it. */
  steers: () => string[];
} {
  const frames = new MessageQueue<SDKMessage>();
  let interrupts = 0;
  const written: string[] = [];
  const sdk = {
    query: ({ prompt }: { prompt: AsyncIterable<unknown> }) => {
      void (async () => {
        // Consume the steers the way the CLI would, then treat EOF as its own exit.
        for await (const message of prompt) {
          const content = (message as { message?: { content?: unknown } })
            .message?.content;
          if (typeof content === "string") written.push(content);
        }
        // And NOT instantly. A real CLI takes a moment to unwind and reap its task groups after
        // stdin closes, and that gap is where a turn ended by closing the input is still accepting
        // steers it can no longer deliver. A stand-in that exits in the same microtask hides it, and
        // hid it from the first version of these tests.
        setTimeout(() => frames.close(), CLI_EXIT_MS);
      })();
      return Object.assign(frames[Symbol.asyncIterator](), {
        interrupt: async () => {
          interrupts += 1;
        },
      });
    },
  } as unknown as ClaudeAgentSdk;
  return {
    sdk,
    emit: (message) => {
      frames.push(message);
    },
    finish: () => frames.close(),
    interrupts: () => interrupts,
    // The opening prompt is not a steer; everything after it was written into a live session.
    steers: () => written.slice(1),
  };
}

const TAPE = { append: () => undefined } as unknown as RawTapeService;

/** How long the stand-in CLI takes to exit after its stdin closes. */
const CLI_EXIT_MS = 50;

export function start(
  sdk: ClaudeAgentSdk,
  steers: () => string[] = () => [],
  /**
   * What `app/` gets to say about the turn while it runs. `mayHold` is read at every `result`, so a
   * test flips its closed-over flag mid-turn exactly as a `rotate` or a context wall would.
   */
  opts: { mayHold?: () => boolean } = {},
): {
  done: Promise<RunResult>;
  events: EngineEvent[];
  holds: boolean[];
  steer: (text: string) => boolean;
  /** Esc, from the engine's side of the keyboard. */
  interrupt: () => Promise<void>;
  /** What the engine itself wrote into the session — see `fakeSdk`. */
  readonly steers: string[];
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
    ...(opts.mayHold ? { mayHold: opts.mayHold } : {}),
  });
  return {
    done: turn.done,
    events,
    holds,
    steer: (text) => turn.steer(text),
    interrupt: () => turn.interrupt(),
    get steers() {
      return steers();
    },
  };
}

/** Let the drain loop run to wherever it is going to block. */
export const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 5));

/**
 * The same, under fake timers, where `settle`'s own `setTimeout` would never fire. Everything between
 * a pushed frame and the loop blocking again is promise work, so draining the microtask queue is
 * enough — and it keeps the grace tests off the wall clock.
 */
export async function flush(): Promise<void> {
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
}

/** Resolved, or still pending? The whole question this file asks. */
export async function isPending(promise: Promise<unknown>): Promise<boolean> {
  const marker = Symbol('pending');
  const race = await Promise.race([promise, Promise.resolve(marker)]);
  return race === marker;
}
