import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CodexTurnHandlers, CodexTurnResult } from '@workspace/codex-sdk';
import type { AdapterRunArgs, EngineLocalHooks } from '../port.js';
import { CodexAppServerAdapter, type CodexHomeProvisioner } from './codex-app-server-adapter.js';

/**
 * Exercises `CodexAppServerAdapter.run()`'s OWN mid-turn wiring — the svc-nudge / leg-rotation steer
 * calls and the write-guard `onApproval` decision — by mocking `@workspace/codex-sdk`'s `CodexClient`
 * and driving the `CodexTurnHandlers` it captures directly. `map-codex-event.spec.ts` covers only the
 * pure `mapCodexEvent` mapping and this adapter's static `capabilities`; the backend's
 * `engine-core.codex-hooks.spec.ts` covers only the hooks `EngineCore` *builds*, against a fully-faked
 * adapter that never runs this file's code. Neither exercises this adapter's own `onEvent`/`onApproval`
 * logic — this spec is that missing coverage.
 */

let capturedHandlers: CodexTurnHandlers | undefined;
const steerCalls: Array<{ threadId: string; turnId: string; text: string }> = [];
let resolveTurn: ((r: CodexTurnResult) => void) | undefined;

vi.mock('@workspace/codex-sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@workspace/codex-sdk')>();
  return {
    ...actual,
    CodexClient: class {
      constructor(_opts: { codexHome: string }) {}
      async init(): Promise<void> {}
      async startThread(_opts: unknown): Promise<{ threadId: string }> {
        return { threadId: 'thread-1' };
      }
      async resumeThread(threadId: string, _opts: unknown): Promise<{ threadId: string }> {
        return { threadId };
      }
      startTurn(
        _threadId: string,
        _input: unknown,
        handlers: CodexTurnHandlers,
        _opts: unknown,
      ): Promise<CodexTurnResult> {
        capturedHandlers = handlers;
        return new Promise<CodexTurnResult>((resolve) => {
          resolveTurn = resolve;
        });
      }
      async steer(threadId: string, turnId: string, input: Array<{ type: string; text?: string }>): Promise<void> {
        steerCalls.push({ threadId, turnId, text: input[0]?.text ?? '' });
      }
      async close(): Promise<void> {}
    },
  };
});

const fakeProvisioner: CodexHomeProvisioner = {
  provision: () => '/tmp/codex-home',
  readRefreshedAuth: () => undefined,
};

function baseArgs(hooks?: EngineLocalHooks): AdapterRunArgs {
  return {
    engine: 'codex',
    task: 'do it',
    cwd: '/tmp/wt',
    systemPrompt: 'persona',
    mode: 'execute',
    sandboxKey: { orgId: 'acme', repoId: 'atlas', jobId: 'feat', type: 'build' },
    auth: { secret: 'auth-blob' },
    ...(hooks ? { hooks } : {}),
  };
}

// `run()` awaits `client.init()` then `client.startThread()` before calling `client.startTurn()` — flush
// enough microtask turns for those to settle and `capturedHandlers` to be populated before driving them.
async function flush(): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

function settleTurn(over: Partial<CodexTurnResult> = {}): void {
  resolveTurn?.({
    threadId: 'thread-1',
    turnId: 'turn-1',
    status: 'completed',
    authHomePath: '/tmp/codex-home',
    ...over,
  });
}

beforeEach(() => {
  capturedHandlers = undefined;
  resolveTurn = undefined;
  steerCalls.length = 0;
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe('CodexAppServerAdapter.run — mid-turn steer wiring', () => {
  it('steers the svc-nudge text when a completed command_execution item matches the rule', async () => {
    const postToolUseContext = vi.fn((toolName: string, input: unknown) =>
      toolName === 'Bash' && (input as { command: string }).command === 'pnpm dev' ? 'nudge: use atlas-svc' : null,
    );
    const adapter = new CodexAppServerAdapter(fakeProvisioner);
    const runPromise = adapter.run(baseArgs({ postToolUseContext }));
    await flush();

    capturedHandlers!.onEvent({
      type: 'itemCompleted',
      threadId: 'thread-1',
      turnId: 'turn-1',
      item: { id: 'c1', type: 'command_execution', command: 'pnpm dev' },
      raw: {},
    });
    expect(steerCalls).toEqual([{ threadId: 'thread-1', turnId: 'turn-1', text: 'nudge: use atlas-svc' }]);

    settleTurn();
    await runPromise;
  });

  it('stays silent when the command does not match the rule, or the completed item is not a command_execution', async () => {
    const postToolUseContext = vi.fn(() => null);
    const adapter = new CodexAppServerAdapter(fakeProvisioner);
    const runPromise = adapter.run(baseArgs({ postToolUseContext }));
    await flush();

    capturedHandlers!.onEvent({
      type: 'itemCompleted',
      threadId: 'thread-1',
      turnId: 'turn-1',
      item: { id: 'c1', type: 'command_execution', command: 'pnpm test' },
      raw: {},
    });
    capturedHandlers!.onEvent({
      type: 'itemCompleted',
      threadId: 'thread-1',
      turnId: 'turn-1',
      item: { id: 'a1', type: 'agent_message', text: 'hi' },
      raw: {},
    });
    expect(steerCalls).toEqual([]);

    settleTurn();
    await runPromise;
  });

  it('does not steer a svc-nudge when no postToolUseContext hook is wired', async () => {
    const adapter = new CodexAppServerAdapter(fakeProvisioner);
    const runPromise = adapter.run(baseArgs());
    await flush();

    capturedHandlers!.onEvent({
      type: 'itemCompleted',
      threadId: 'thread-1',
      turnId: 'turn-1',
      item: { id: 'c1', type: 'command_execution', command: 'pnpm dev' },
      raw: {},
    });
    expect(steerCalls).toEqual([]);

    settleTurn();
    await runPromise;
  });

  it('level-latches the leg-rotation steer: soft text once at the threshold, reminder text on the next band, never a repeat', async () => {
    const rotation = { softTokens: 100, reminderDeltaTokens: 50, softText: 'soft-nudge', reminderText: 'reminder-nudge' };
    const adapter = new CodexAppServerAdapter(fakeProvisioner);
    const runPromise = adapter.run(baseArgs({ rotation }));
    await flush();

    const tokenUsage = (inputTokens: number) =>
      capturedHandlers!.onEvent({
        type: 'tokenUsageUpdated',
        threadId: 'thread-1',
        turnId: 'turn-1',
        usage: { inputTokens },
        raw: {},
      });

    tokenUsage(50); // below softTokens: no steer
    expect(steerCalls).toEqual([]);

    tokenUsage(100); // at softTokens, level 0 (first fire): soft text
    expect(steerCalls).toEqual([{ threadId: 'thread-1', turnId: 'turn-1', text: 'soft-nudge' }]);

    tokenUsage(100); // same level again: no repeat
    expect(steerCalls).toHaveLength(1);

    tokenUsage(150); // next band, level 1: reminder text
    expect(steerCalls).toEqual([
      { threadId: 'thread-1', turnId: 'turn-1', text: 'soft-nudge' },
      { threadId: 'thread-1', turnId: 'turn-1', text: 'reminder-nudge' },
    ]);

    settleTurn();
    await runPromise;
  });

  it('does not steer rotation when no rotation hook is wired', async () => {
    const adapter = new CodexAppServerAdapter(fakeProvisioner);
    const runPromise = adapter.run(baseArgs());
    await flush();

    capturedHandlers!.onEvent({
      type: 'tokenUsageUpdated',
      threadId: 'thread-1',
      turnId: 'turn-1',
      usage: { inputTokens: 1_000_000 },
      raw: {},
    });
    expect(steerCalls).toEqual([]);

    settleTurn();
    await runPromise;
  });
});

describe('CodexAppServerAdapter.run — onApproval write-guard wiring', () => {
  it('declines a fileChange approval when writeGuard denies it', async () => {
    const writeGuard = vi.fn(() => ({ allow: false, reason: 'nope' }));
    const adapter = new CodexAppServerAdapter(fakeProvisioner);
    const runPromise = adapter.run(baseArgs({ writeGuard }));
    await flush();

    const decision = await capturedHandlers!.onApproval!({
      kind: 'fileChange',
      threadId: 'thread-1',
      turnId: 'turn-1',
      itemId: 'fc1',
      raw: { path: '/etc/passwd' },
    });
    expect(decision).toBe('decline');
    expect(writeGuard).toHaveBeenCalledWith('fileChange', { path: '/etc/passwd' });

    settleTurn();
    await runPromise;
  });

  it('accepts a fileChange approval when writeGuard allows it', async () => {
    const writeGuard = vi.fn(() => ({ allow: true }));
    const adapter = new CodexAppServerAdapter(fakeProvisioner);
    const runPromise = adapter.run(baseArgs({ writeGuard }));
    await flush();

    const decision = await capturedHandlers!.onApproval!({
      kind: 'fileChange',
      threadId: 'thread-1',
      turnId: 'turn-1',
      itemId: 'fc1',
      raw: { path: '/tmp/wt/a.ts' },
    });
    expect(decision).toBe('accept');

    settleTurn();
    await runPromise;
  });

  it('defaults to accept when no writeGuard hook is wired', async () => {
    const adapter = new CodexAppServerAdapter(fakeProvisioner);
    const runPromise = adapter.run(baseArgs());
    await flush();

    const decision = await capturedHandlers!.onApproval!({
      kind: 'commandExecution',
      threadId: 'thread-1',
      turnId: 'turn-1',
      itemId: 'ce1',
      raw: {},
    });
    expect(decision).toBe('accept');

    settleTurn();
    await runPromise;
  });
});
