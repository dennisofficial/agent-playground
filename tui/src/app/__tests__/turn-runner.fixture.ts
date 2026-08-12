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
import { EMessageType, type ESessionEndReason } from '../../generated/prisma/enums.js';
import type { EngineSession, Thread } from '../../generated/prisma/client.js';
import type { RunArgs, RunResult, RunningTurn } from '../../engine/claude-engine.service.js';
import { ContextPressureService } from '../context-pressure.service.js';
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
/**
 * What a rotation opens: a row with no engine session id yet, because nothing has been said on it.
 * That null is load-bearing — it is what stops a wall on a fresh leg rotating again, forever.
 */
export const NEXT_SESSION = {
  ...SESSION,
  id: 'session-2',
  engineSessionId: null,
  ordinal: 2,
} as unknown as EngineSession;

export class FakeEngine {
  lastArgs?: RunArgs;
  steerCallback?: () => void;
  interrupted = false;
  script: EngineEvent[] = [];
  readonly steerTexts: string[] = [];
  /** Whatever the post-tool hook returned, in order — what the model would have been handed. */
  readonly toolBoundaries: (string | undefined)[] = [];
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
      for (const event of engine.script) {
        args.onEvent(event);
        // The real hook fires after each tool call, which is the ONLY moment Atlas can speak into a
        // turn. Driving it off the scripted `tool_result` keeps the fake honest about ordering: the
        // occupancy reading always arrives before the boundary that acts on it.
        if (event.kind === 'tool_result' && args.onToolBoundary) {
          engine.toolBoundaries.push(await args.onToolBoundary());
        }
      }
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
    // Null means "this thread has no session but the one you were handed" — the ordinary case. A
    // test about rotation overrides it to hand the runner the leg that replaced its copy.
    currentForThread: mock(async (): Promise<EngineSession | null> => null),
  };
  const vault = {
    freshCredential: mock(async () => ({ claudeAiOauth: {} })),
    adopt: mock(async () => false),
  };
  const env = { CLAUDE_CONFIG_DIR: '/tmp/claude', CLAUDE_CODE_OAUTH_TOKEN: 'tok' };
  const homes = {
    prepareClaudeHome: mock(() => env),
    claim: mock(async (_args: unknown, start: (e: typeof env) => unknown) => start(env)),
    // Null by default: the engine leaving the credential exactly as Atlas wrote it is the ordinary
    // case, and a turn must not write material on the strength of an unchanged file.
    observeClaudeCredential: mock((_accountId: string): unknown => null),
  };
  const rotator = { considerRotation: mock(async () => ({ kind: 'kept' as const })) };
  const turns = {
    record: mock(async (_args: Record<string, unknown>) => undefined),
    lastForThread: mock(async () => null),
  };
  const usage = { track: mock(), stopTracking: mock(), kick: mock() };


  // Only the two methods a turn can reach: the runner never opens or closes a session itself, it
  // only rotates one that hit the context wall.
  const sessionManager = {
    // Typed with the real signature so a test can read back WHICH session was retired, for what
    // reason, and with what hand-off — the three facts a rotation is.
    rotateSession: mock(
      async (
        _thread: Thread,
        _current: EngineSession,
        _endReason: ESessionEndReason,
        _handoff?: string,
      ): Promise<EngineSession> => NEXT_SESSION,
    ),
    currentSession: mock(async (): Promise<EngineSession> => SESSION),
  };

  // The real one: it holds nothing but arithmetic over the readings this turn produces, so a fake
  // would be a second implementation of the escalation the specs are here to pin.
  const pressure = new ContextPressureService();

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
    sessionManager as never,
    pressure,
  );

  return {
    runner,
    engine,
    messages,
    pressure,
    store,
    stores,
    accounts,
    sessions,
    sessionManager,
    turns,
    rotator,
    homes,
    vault,
    usage,
  };
}
