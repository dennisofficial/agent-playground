import type { SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import type { EngineLocalHooks } from '@workspace/agent-engine';
import { fromExternal, type AgentMessage } from '../../prompt-kit/message';
import type { RunEngineArgs } from '../engine.types';

/** A user message the SDK's streaming input accepts (mid-turn steering uses `priority:'now'`). */
function steerUserMessage(
  content: AgentMessage,
  priority?: 'now' | 'next' | 'later',
): SDKUserMessage {
  return {
    type: 'user',
    message: { role: 'user', content },
    parent_tool_use_id: null,
    ...(priority ? { priority } : {}),
  };
}

/**
 * A hand-driven async-iterable the engine feeds the SDK in STREAMING-INPUT mode: `push` a message to
 * deliver it to the live turn, `end` to close input so the query completes. Mirrors the spike harness.
 */
function makeManualInput(): {
  stream: AsyncIterable<SDKUserMessage>;
  push: (m: SDKUserMessage) => void;
  end: () => void;
} {
  const queue: SDKUserMessage[] = [];
  let resolveNext: ((r: IteratorResult<SDKUserMessage>) => void) | null = null;
  let done = false;
  return {
    push(m) {
      if (resolveNext) {
        const r = resolveNext;
        resolveNext = null;
        r({ value: m, done: false });
      } else queue.push(m);
    },
    end() {
      done = true;
      if (resolveNext) {
        const r = resolveNext;
        resolveNext = null;
        r({ value: undefined as never, done: true });
      }
    },
    stream: {
      [Symbol.asyncIterator]() {
        return {
          next(): Promise<IteratorResult<SDKUserMessage>> {
            if (queue.length)
              return Promise.resolve({
                value: queue.shift() as SDKUserMessage,
                done: false,
              });
            if (done) return Promise.resolve({ value: undefined as never, done: true });
            return new Promise((res) => {
              resolveNext = res;
            });
          },
        };
      },
    },
  };
}

/**
 * After the model emits a `result` in streaming-input mode, wait this long for an in-flight steer to
 * arrive (Redis publish→subscribe latency) before closing the input and ending the turn. A no-steer turn
 * pays this as a small completion tail.
 */
const STEER_IDLE_GRACE_MS = 350;

/**
 * STREAMING-INPUT mode (the steerable brain turn): feed the SDK a live async-iterable that yields the initial
 * task, then drains `steerInput` (operator steers) with `priority:'now'`. The turn ends when the model emits a
 * `result` and no steer arrives within a short grace. Non-steerable turns keep the plain string prompt
 * (single-message mode) — zero behavior change for build/plan/review workers.
 *
 * This owns the manual-input handle, the steer-idle close timer, the pre-stream steer buffer, and the detached
 * consumer that drains the operator steer source. `runClaude`'s message loop coordinates with it via
 * `cancelEnd`/`scheduleEnd` (also called by the {@link BackgroundHoldTimer} decision tree), `markStreamingStarted`
 * (on the first assistant message), and `injectRotationNudge` (the engine-local leg-rotation nudge).
 */
export class SteerInputChannel {
  readonly streaming: boolean;
  private readonly input?: ReturnType<typeof makeManualInput>;
  private readonly steerIter?: AsyncIterator<{ id?: string; text: string }>;
  private endTimer?: ReturnType<typeof setTimeout>;
  private turnEndedFlag = false;
  private streamingStarted = false;
  private readonly steerBuffer: Array<{ id?: string; text: string }> = [];
  private flushSteerBuffer: () => void = () => {}; // real impl set below when streaming; no-op for worker turns
  private liveSteerPush: (text: string) => void = () => {}; // real impl set below when streaming

  constructor(
    steerInput: RunEngineArgs['steerInput'],
    private readonly task: AgentMessage,
    hooks: EngineLocalHooks | undefined,
    onEvent: RunEngineArgs['onEvent'],
  ) {
    this.streaming = !!steerInput;
    this.input = this.streaming ? makeManualInput() : undefined;
    this.steerIter = this.streaming ? steerInput![Symbol.asyncIterator]() : undefined;
    if (!this.input) return;
    const input = this.input;
    input.push(steerUserMessage(task));
    // Drain operator steers into the live turn until the turn ends. Each steer carries its stimulus `id`;
    // we push it into the session with priority:'now', then emit an `input_ack` echoing the id — the
    // durable proof the message was TAKEN (the host stamps delivered_at only on this ack, never on the
    // stream write). A redelivered id (a lost ack re-driven by the delivery pump) is a NO-OP push
    // (exactly-once injection) but STILL re-emits its ack so delivery converges. A steer held pre-stream
    // is NOT acked until it is actually injected (on flush), so a turn that dies before first content
    // leaves the message pending (delivered_at null) for the sweep — no acked-but-dropped message.
    const injectedSteerIds = new Set<string>();
    const bufferedIds = new Set<string>();
    const injectSteer = (id: string | undefined, text: AgentMessage): void => {
      this.cancelEnd(); // a steer is in flight to the model — don't close input under it
      input.push(steerUserMessage(text, 'now'));
      if (typeof id === 'string') {
        injectedSteerIds.add(id);
        onEvent?.({ kind: 'input_ack', id });
      }
    };
    this.flushSteerBuffer = (): void => {
      while (this.steerBuffer.length) {
        const s = this.steerBuffer.shift()!;
        injectSteer(s.id, fromExternal(s.text));
      }
    };
    // One shared live-injection closure: push a message into the open stream as a priority:'now' steer,
    // cancelling any pending close — the SAME mechanism an operator steer uses, but with no stimulus id (so
    // it emits no `input_ack`; nothing durable to converge on). Both the engine-local rotation nudge and the
    // capability-gated `hooks.steer` channel (bg-task-cap notice, thread-3 JIT steers) route through it.
    this.liveSteerPush = (text: string): void => {
      this.cancelEnd();
      input.push(steerUserMessage(fromExternal(text), 'now'));
    };
    if (hooks?.steer) hooks.steer.push = this.liveSteerPush;
    void (async () => {
      try {
        while (!this.turnEndedFlag && this.steerIter) {
          const { value, done } = await this.steerIter.next();
          if (done || this.turnEndedFlag) break;
          const text = value?.text;
          if (typeof text !== 'string' || text.length === 0) continue;
          const id = value?.id;
          if (typeof id === 'string' && injectedSteerIds.has(id)) {
            // Re-delivered after a lost ack — re-emit the ack so delivery converges; never re-push.
            onEvent?.({ kind: 'input_ack', id });
            continue;
          }
          if (typeof id === 'string' && bufferedIds.has(id)) continue; // already held (not yet taken → no ack)
          if (!this.streamingStarted) {
            this.steerBuffer.push({ id, text }); // HOLD until first assistant message (see note below)
            if (typeof id === 'string') bufferedIds.add(id);
            continue;
          }
          injectSteer(id, fromExternal(text));
        }
      } catch {
        /* steer source closed — the turn's own lifecycle ends it */
      }
    })();
  }

  /** The `prompt` the SDK query consumes: the live manual-input stream when streaming, else the plain task. */
  get prompt(): AsyncIterable<SDKUserMessage> | AgentMessage {
    return this.streaming ? this.input!.stream : this.task;
  }

  /** The turn has begun unwinding — the detached steer consumer breaks and the {@link BackgroundHoldTimer}
   *  never caps after this. */
  get turnEnded(): boolean {
    return this.turnEndedFlag;
  }

  cancelEnd(): void {
    if (this.endTimer) {
      clearTimeout(this.endTimer);
      this.endTimer = undefined;
    }
  }

  scheduleEnd(): void {
    if (!this.input) return;
    this.cancelEnd();
    this.endTimer = setTimeout(() => this.input!.end(), STEER_IDLE_GRACE_MS);
  }

  // A priority:'now' steer pushed BEFORE the model commits its first assistant message makes the SDK abort
  // the whole turn (result_type=user, terminal_reason=aborted_streaming, subtype=error_during_execution) —
  // the startup-race red box. So a steer that arrives while the turn is still spinning up is HELD in
  // `steerBuffer` and flushed the instant the first `assistant` message lands, at which point a mid-turn steer
  // injects cleanly (subtype=success, steer honored). Must be called on an `assistant` message, NOT a
  // stream_event content delta — flushing on a partial delta still aborts (verified by spike). Idempotent.
  markStreamingStarted(): void {
    if (this.streamingStarted) return;
    this.streamingStarted = true;
    this.flushSteerBuffer();
  }

  /** Inject the engine-local leg-rotation nudge as a `priority:'now'` steer into the LIVE turn — no-op on a
   *  non-streaming worker turn. */
  injectRotationNudge(text: AgentMessage): void {
    this.liveSteerPush(text);
  }

  /** Mark the turn ended so the detached steer consumer + entrypoint generator unwind. */
  markTurnEnded(): void {
    this.turnEndedFlag = true;
  }

  /** Close input (completes the query) and return the steer iterator so its source unwinds. */
  dispose(): void {
    this.input?.end();
    void this.steerIter?.return?.(undefined);
  }
}
