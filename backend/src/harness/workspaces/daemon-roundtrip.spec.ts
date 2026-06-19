/**
 * Phase 5 host↔daemon round-trip tests — the FULL transport, end to end, over the in-memory Redis fake
 * (NO live Redis). One `InMemoryRedisStream` is shared by the host `DaemonClient` and the daemon's
 * consumer loop + dispatchers, so a command XADD'd by the client is consumed by the daemon, whose
 * frames stream back to the client — exactly the production path minus ioredis.
 *
 * Covers the four contracted round-trips:
 *   (a) run → streamed events arrive at onEvent IN ORDER → terminal result resolves dispatchRun;
 *   (b) abort → the daemon's per-run AbortController fires (the engine observes signal.aborted);
 *   (c) error frame → dispatchRun rejects;
 *   (d) git call → reply resolves with the method's return value.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EnvService } from '@core/config/env/env.service';
import type {
  RunWorkerArgs,
  WorkerEngine,
  WorkerEvent,
} from '@harness/engines/worker-engine.port';
import { EWorkerEngineName } from '@harness/engines/worker-engine.port';
import { InMemoryRedisStream } from '../../_lib/redis/in-memory-redis-stream';
import { DaemonClient } from './daemon-client';
import type { RunCommandPayload } from './daemon-protocol';
import { DaemonCommandConsumer } from '../../daemon/rpc/daemon-command.consumer';
import { DaemonGitDispatcher } from '../../daemon/rpc/daemon-git.dispatcher';
import { DaemonTurnService } from '../../daemon/rpc/daemon-turn.service';
import type { DaemonEngineRegistry } from '../../daemon/engines/daemon-engine.registry';
import type { DaemonAgentToolsProvider } from '../../daemon/engines/daemon-agent-tools-provider.service';
import type { DaemonGitService } from '../../daemon/git/daemon-git.service';

const WORKSPACE_ID = 'ws-test-uuid';

/** A configurable fake engine — its `run` implementation is swapped per test. */
class FakeEngine implements WorkerEngine {
  readonly name = EWorkerEngineName.CLAUDE;
  impl: (args: RunWorkerArgs) => Promise<{
    result: string;
    sessionId?: string;
    questions?: never[];
    planText?: string;
    usage?: { inputTokens?: number };
  }> = async () => ({ result: 'ok' });
  run(args: RunWorkerArgs) {
    return this.impl(args);
  }
}

/** Wait until `cond()` is true, polling the event loop (no real timers). */
async function until(cond: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error('until() timed out');
    await new Promise((r) => setImmediate(r));
  }
}

describe('Phase 5 host↔daemon round-trips (in-memory Redis)', () => {
  let redis: InMemoryRedisStream;
  let client: DaemonClient;
  let engine: FakeEngine;
  let consumer: DaemonCommandConsumer;
  let tools: { prime: ReturnType<typeof vi.fn> };
  let git: Record<string, ReturnType<typeof vi.fn>>;
  const prevWorkspaceId = process.env.WORKSPACE_ID;

  const basePayload = (over: Partial<RunCommandPayload> = {}): RunCommandPayload => ({
    engine: 'claude',
    workAreaId: 'wa-1',
    sessionId: 'sess-1',
    task: 'do the thing',
    systemPrompt: 'you are a worker',
    agentId: 'atlas',
    mode: 'execute',
    skillSources: [],
    mcpServers: [],
    ...over,
  });

  beforeEach(() => {
    process.env.WORKSPACE_ID = WORKSPACE_ID;
    redis = new InMemoryRedisStream();
    engine = new FakeEngine();

    // Daemon collaborators (fakes — the transport is what's under test, not the engine/git internals).
    const registry = {
      get: vi.fn(() => engine),
    } as unknown as DaemonEngineRegistry;
    tools = { prime: vi.fn(async () => ({ skillNames: [], skillsPrompt: '', mcpServers: [] })) };
    git = {
      // The turn path awaits the boot clone (Phase 11) before resolving cwd — resolve immediately.
      whenCloned: vi.fn(async () => undefined),
      worktreePath: vi.fn(() => '/workspace/repo/.workspaces/sess-1'),
      createWorktree: vi.fn(async () => '/workspace/repo/.workspaces/sess-1'),
      publish: vi.fn(async () => ({ integrated: true, sharedBranch: 'shared/x' })),
      openPr: vi.fn(async () => ({ number: 42, url: 'https://gh/pr/42' })),
      // Phase 11 RPCs — exercised through the allowlist to prove the new entries are reachable.
      reviewRange: vi.fn(async () => ({
        range: 'cut...agent/sess-1',
        files: ['a.ts'],
        baseBranch: 'main',
      })),
      attachDesign: vi.fn(async () => ({ ok: true, message: 'attached' })),
      markReady: vi.fn(async () => ({ isDraft: false })),
      commentPr: vi.fn(async () => undefined),
    };

    const turns = new DaemonTurnService(
      registry,
      tools as unknown as DaemonAgentToolsProvider,
      git as unknown as DaemonGitService,
      redis,
    );
    const gitDispatcher = new DaemonGitDispatcher(
      git as unknown as DaemonGitService,
      redis,
    );
    consumer = new DaemonCommandConsumer(
      redis,
      { get: () => undefined } as unknown as EnvService,
      turns,
      gitDispatcher,
    );
    consumer.onApplicationBootstrap(); // start the daemon consuming ws:{id}:cmds

    client = new DaemonClient(redis);
  });

  afterEach(async () => {
    // Kick off shutdown, then eagerly release the loop's in-flight blocking read so it exits at once
    // instead of waiting out its 5s block window (keeps the suite fast).
    const shutdown = consumer.onApplicationShutdown();
    redis.releaseBlockingReads();
    await shutdown;
    if (prevWorkspaceId === undefined) delete process.env.WORKSPACE_ID;
    else process.env.WORKSPACE_ID = prevWorkspaceId;
  });

  it('(a) streams events in order and resolves with the terminal result', async () => {
    engine.impl = async (args) => {
      args.onEvent({ kind: 'text', text: 'one' });
      args.onEvent({ kind: 'tool', name: 'Read', detail: 'file.ts' });
      args.onEvent({ kind: 'text', text: 'two' });
      return {
        result: 'final report',
        sessionId: 'engine-sess-9',
        planText: 'the plan',
        usage: { inputTokens: 123 },
      };
    };

    const seen: WorkerEvent[] = [];
    const result = await client.dispatchRun(
      WORKSPACE_ID,
      basePayload(),
      (e) => seen.push(e),
    );

    expect(seen).toEqual([
      { kind: 'text', text: 'one' },
      { kind: 'tool', name: 'Read', detail: 'file.ts' },
      { kind: 'text', text: 'two' },
    ]);
    expect(result).toEqual({
      result: 'final report',
      sessionId: 'engine-sess-9',
      questions: undefined,
      planText: 'the plan',
      usage: { inputTokens: 123 },
    });
    // The daemon primed tools from the host-shipped inputs before running.
    expect(tools.prime).toHaveBeenCalledWith('atlas', {
      skillSources: [],
      mcpServers: [],
    });
  });

  it('reconstitutes the engine run with the wire payload (cwd overridden, fields verbatim)', async () => {
    let captured: RunWorkerArgs | undefined;
    engine.impl = async (args) => {
      captured = args;
      return { result: 'ok' };
    };

    await client.dispatchRun(
      WORKSPACE_ID,
      basePayload({
        task: 'investigate X',
        resumeSessionId: 'prior-engine-sess',
        model: 'claude-x',
        effort: 'high',
        mode: 'investigate',
        engineAuth: { mode: 'api_key', apiKey: 'sk-tenant' },
      }),
      () => undefined,
    );

    expect(captured).toBeDefined();
    expect(captured!.task).toBe('investigate X');
    expect(captured!.cwd).toBe('/workspace/repo/.workspaces/sess-1'); // daemon-supplied, not from wire
    expect(captured!.systemPrompt).toBe('you are a worker');
    expect(captured!.agentId).toBe('atlas');
    expect(captured!.sessionId).toBe('prior-engine-sess'); // resumeSessionId → engine resume handle
    expect(captured!.model).toBe('claude-x');
    expect(captured!.effort).toBe('high');
    expect(captured!.mode).toBe('investigate');
    expect(captured!.engineAuth).toEqual({ mode: 'api_key', apiKey: 'sk-tenant' });
    expect(typeof captured!.onEvent).toBe('function');
    expect(captured!.signal).toBeInstanceOf(AbortSignal);
  });

  it('creates the worktree when none exists yet (cwd resolution)', async () => {
    git.worktreePath = vi.fn(() => undefined); // no existing worktree
    let cwd: string | undefined;
    engine.impl = async (args) => {
      cwd = args.cwd;
      return { result: 'ok' };
    };

    await client.dispatchRun(WORKSPACE_ID, basePayload(), () => undefined);

    // cwd resolves off the WORK AREA (payload.workAreaId), not the harness session id.
    expect(git.createWorktree).toHaveBeenCalledWith('wa-1');
    expect(cwd).toBe('/workspace/repo/.workspaces/sess-1');
  });

  it('(b) aborting the host signal fires the daemon run AbortController', async () => {
    const ac = new AbortController();
    let observedAbort = false;
    let runStarted = false;
    engine.impl = (args) =>
      new Promise((resolve) => {
        runStarted = true;
        args.signal?.addEventListener('abort', () => {
          observedAbort = true;
          resolve({ result: 'aborted' });
        });
        // Never resolves on its own — only the abort ends this run.
      });

    const runPromise = client.dispatchRun(
      WORKSPACE_ID,
      basePayload(),
      () => undefined,
      ac.signal,
    );

    // Wait until the daemon's run has actually started (tools primed, abort subscription registered,
    // engine.run entered) before aborting — otherwise the abort would race ahead of the subscription.
    await until(() => runStarted);
    await new Promise((r) => setImmediate(r));
    ac.abort();

    const result = await runPromise;
    expect(observedAbort).toBe(true);
    expect(result.result).toBe('aborted');
  });

  it('(c) an engine throw becomes an error frame that rejects dispatchRun', async () => {
    engine.impl = async () => {
      throw new Error('engine blew up');
    };

    await expect(
      client.dispatchRun(WORKSPACE_ID, basePayload(), () => undefined),
    ).rejects.toThrow(/daemon run failed: engine blew up/);
  });

  it('(d) a git call resolves with the method return value', async () => {
    const value = await client.gitCall(WORKSPACE_ID, 'publish', ['sess-1']);
    expect(git.publish).toHaveBeenCalledWith('sess-1');
    expect(value).toEqual({ integrated: true, sharedBranch: 'shared/x' });
  });

  it('a git call to an unknown method rejects (allowlist guard)', async () => {
    await expect(
      client.gitCall(WORKSPACE_ID, 'rmRfSlashEtc', []),
    ).rejects.toThrow(/unknown git RPC method 'rmRfSlashEtc'/);
  });

  it('(Phase 11) the new RPCs are on the allowlist and round-trip through the dispatcher', async () => {
    const range = await client.gitCall(WORKSPACE_ID, 'reviewRange', ['sess-1']);
    expect(git.reviewRange).toHaveBeenCalledWith('sess-1');
    expect(range).toMatchObject({ range: 'cut...agent/sess-1', baseBranch: 'main' });

    await client.gitCall(WORKSPACE_ID, 'attachDesign', ['YmFzZTY0']);
    expect(git.attachDesign).toHaveBeenCalledWith('YmFzZTY0');

    await client.gitCall(WORKSPACE_ID, 'markReady', [42]);
    expect(git.markReady).toHaveBeenCalledWith(42);

    await client.gitCall(WORKSPACE_ID, 'commentPr', [42, 'findings']);
    expect(git.commentPr).toHaveBeenCalledWith(42, 'findings');
  });

  it('a git method that throws becomes an error reply that rejects gitCall', async () => {
    git.openPr = vi.fn(async () => {
      throw new Error('no PR for you');
    });
    await expect(
      client.gitCall(WORKSPACE_ID, 'openPr', [{ sessionId: 'sess-1' }]),
    ).rejects.toThrow(/daemon git 'openPr' failed: no PR for you/);
  });
});
