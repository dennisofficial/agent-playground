import type { SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import type { EngineLocalHooks } from '@workspace/agent-engine';
import { fromExternal, type AgentMessage } from '../../prompt-kit/message';
import type { RunEngineArgs } from '../engine.types';

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

const STEER_IDLE_GRACE_MS = 350;

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
      } catch {}
    })();
  }

  get prompt(): AsyncIterable<SDKUserMessage> | AgentMessage {
    return this.streaming ? this.input!.stream : this.task;
  }

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

  markStreamingStarted(): void {
    if (this.streamingStarted) return;
    this.streamingStarted = true;
    this.flushSteerBuffer();
  }

  injectRotationNudge(text: AgentMessage): void {
    this.liveSteerPush(text);
  }

  markTurnEnded(): void {
    this.turnEndedFlag = true;
  }

  dispose(): void {
    this.input?.end();
    void this.steerIter?.return?.(undefined);
  }
}
