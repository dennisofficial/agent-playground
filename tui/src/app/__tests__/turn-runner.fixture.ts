/**
 * The turn-runner harness: a scripted fake engine, a fake message repository that reports its own
 * concurrency, and `build()` — every collaborator stubbed except the real `ConversationStoreRegistry`
 * and the runner itself.
 *
 * Shared by the specs either side of it so that the fakes cannot drift apart: a steering test and an
 * ordering test disagreeing about what the engine does would be worse than either being wrong.
 */

import { mock } from 'bun:test';
import { EHarnessVariant } from '../../domain/message.js';
import type { EngineEvent, Message, MessagePayload } from '../../domain/message.js';
import { buildSystemPrompt } from '../../domain/system-prompt.js';
import { EMessageType } from '../../generated/prisma/enums.js';
import type { EngineSession, Thread } from '../../generated/prisma/client.js';
import type { RunArgs, RunResult, RunningTurn } from '../../engine/claude-engine.service.js';
import { ConversationStoreRegistry } from '../conversation-store.registry.js';
import { TurnRunnerService } from '../turn-runner.service.js';

export const THREAD = { id: 'thread-1', role: 'builder' } as unknown as Thread;
export const OTHER_THREAD = { id: 'thread-2', role: 'builder' } as unknown as Thread;
export const SESSION = {
  id: 'session-1',
  accountId: 'account-1',
  engine: 'claude',
  model: 'claude-opus-5',
  engineSessionId: null,
  ordinal: 1,
} as unknown as EngineSession;

export class FakeEngine {
  lastArgs?: RunArgs;
  steerCallback?: () => void;
  interrupted = false;
  script: EngineEvent[] = [];
  readonly steerTexts: string[] = [];
  runs = 0;
  private concurrent = 0;
  maxConcurrent = 0;
  hold?: Promise<void>;

  start(args: RunArgs): RunningTurn {
    this.lastArgs = args;
    this.runs += 1;
    this.concurrent += 1;
    this.maxConcurrent = Math.max(this.maxConcurrent, this.concurrent);

    const engine = this;
    let live = true;
    const done = (async (): Promise<RunResult> => {
      for (const event of engine.script) args.onEvent(event);
      await (engine.hold ?? Promise.resolve());
      live = false;
      engine.concurrent -= 1;
      return { ok: true, engineSessionId: 'sdk-session-1', interrupted: engine.interrupted };
    })();

    return {
      steer(text: string, onConsumed?: () => void): boolean {
        if (!live) return false;
        engine.steerTexts.push(text);
        engine.steerCallback = onConsumed;
        return true;
      },
      async interrupt(): Promise<void> {
        engine.interrupted = true;
      },
      get pendingSteers(): number {
        return 0;
      },
      done,
    };
  }
}

export class FakeMessageRepository {
  readonly appended: { payload: MessagePayload; sessionId: string }[] = [];
  slow = false;
  inFlight = 0;
  maxInFlight = 0;
  private ordinal = 0;

  async append(args: { threadId: string; sessionId: string; payload: MessagePayload }): Promise<Message> {
    this.inFlight += 1;
    this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
    if (this.slow) await new Promise((resolve) => setImmediate(resolve));
    this.appended.push({ payload: args.payload, sessionId: args.sessionId });
    this.inFlight -= 1;
    return {
      id: `m-${this.ordinal}`,
      threadId: args.threadId,
      sessionId: args.sessionId,
      ordinal: this.ordinal++,
      payload: args.payload,
      createdAt: new Date(0),
    };
  }
}

export function build(script: EngineEvent[] = []) {
  const engine = new FakeEngine();
  engine.script = script;
  const messages = new FakeMessageRepository();
  const stores = new ConversationStoreRegistry();
  const store = stores.for(THREAD.id);

  const accounts = {
    recordUsage: mock(async () => undefined),
    findById: mock(async () => null),
  };
  const sessions = {
    recordEngineSessionId: mock(async () => undefined),
    recordContextPercent: mock(async () => undefined),
  };
  const vault = { freshCredential: mock(async () => ({ claudeAiOauth: {} })) };
  const env = { CLAUDE_CONFIG_DIR: '/tmp/claude', CLAUDE_CODE_OAUTH_TOKEN: 'tok' };
  const homes = {
    prepareClaudeHome: mock(() => env),
    claim: mock(async (_blob: unknown, start: (e: typeof env) => unknown) => start(env)),
  };
  const rotator = { considerRotation: mock(async () => ({ kind: 'kept' as const })) };
  const turns = {
    record: mock(async (_args: Record<string, unknown>) => undefined),
    lastForThread: mock(async () => null),
  };
  const usage = { track: mock(), stopTracking: mock(), kick: mock() };


  const runner = new TurnRunnerService(
    engine as never,
    vault as never,
    homes as never,
    rotator as never,
    usage as never,
    accounts as never,
    messages as never,
    sessions as never,
    turns as never,
    stores,
  );

  return {
    runner,
    engine,
    messages,
    store,
    stores,
    accounts,
    sessions,
    turns,
    rotator,
    homes,
    vault,
    usage,
  };
}
