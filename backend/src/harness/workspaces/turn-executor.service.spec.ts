/**
 * Phase 7 — `TurnExecutor` fork unit tests.
 *
 *  (a) LOCAL branch (the production default, isContainerized=false): `run` delegates VERBATIM to
 *      `engines.get(engineName).run(args)` — same engine name, the EXACT args object (cwd/onEvent/
 *      signal untouched) — and returns the engine's result unchanged. This is the byte-identical
 *      contract the live hot path relies on.
 *  (b) REMOTE branch: with `isContainerized` forced true (a test-only subclass override — the real
 *      policy is hard-false until Phase 9), `run` routes to `RemoteTurnDispatcher.dispatch` instead and
 *      does NOT touch the local engine registry.
 *
 * Both use plain fakes (no Nest container).
 */
import { describe, expect, it, vi } from 'vitest';
import type { EngineRegistry } from '../engines/engine.registry';
import {
  EWorkerEngineName,
  type EngineRunResult,
  type RunWorkerArgs,
} from '../engines/worker-engine.port';
import type { RemoteTurnDispatcher } from './remote-turn.dispatcher';
import type { SandboxRegistry } from './sandbox-registry';
import { WorkspaceRegistry } from './workspace-registry';
import { TurnExecutor, type TurnRoutingCtx } from './turn-executor.service';

/** A SandboxRegistry stand-in — `has()` defaults false (the local path); the test-only subclass forces
 * the routing decision directly, so this is just a constructor placeholder. */
const noSandboxes = { has: () => false } as unknown as SandboxRegistry;
/** An empty work-area registry (no work area resolves to a sandbox ⇒ local). */
const noWorkAreas = new WorkspaceRegistry();

const CTX: TurnRoutingCtx = {
  team: 'team-1',
  project: 'proj-1',
  workspaceId: 'ws-001',
};

function makeArgs(over: Partial<RunWorkerArgs> = {}): RunWorkerArgs {
  return {
    task: 'do the thing',
    cwd: '/tmp/ws-001-work',
    systemPrompt: 'you are a worker',
    agentId: 'alex',
    mode: 'execute',
    onEvent: vi.fn(),
    signal: new AbortController().signal,
    ...over,
  };
}

const RESULT: EngineRunResult = { result: 'done', sessionId: 'engine-sess-9' };

/** A TurnExecutor whose routing policy is forced for the test (the real `isContainerized` is hard-false
 * this phase; Phase 9 implements it). */
class TestableTurnExecutor extends TurnExecutor {
  constructor(
    engines: EngineRegistry,
    remote: RemoteTurnDispatcher,
    private readonly forceContainerized: boolean,
  ) {
    super(engines, remote, noSandboxes, noWorkAreas);
  }
  protected isContainerized(): boolean {
    return this.forceContainerized;
  }
}

describe('TurnExecutor fork', () => {
  it('(a) LOCAL: delegates verbatim to engines.get(name).run(args) and returns its result', async () => {
    const run = vi.fn(async () => RESULT);
    const get = vi.fn(() => ({ name: EWorkerEngineName.CLAUDE, run }));
    const engines = { get } as unknown as EngineRegistry;
    const dispatch = vi.fn();
    const remote = { dispatch } as unknown as RemoteTurnDispatcher;

    // The real executor — no work area resolves to a sandbox, so this exercises the local default.
    const exec = new TurnExecutor(engines, remote, noSandboxes, noWorkAreas);
    const args = makeArgs();
    const out = await exec.run(CTX, EWorkerEngineName.CLAUDE, args);

    expect(get).toHaveBeenCalledWith(EWorkerEngineName.CLAUDE);
    // Same args OBJECT passed through untouched — cwd/onEvent/signal included.
    expect(run).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledWith(args);
    // identity: the exact args object is passed through, nothing copied/rewritten.
    const firstCall = (run as unknown as { mock: { calls: unknown[][] } }).mock
      .calls[0];
    expect(firstCall[0]).toBe(args);
    expect(out).toBe(RESULT); // result returned unchanged
    expect(dispatch).not.toHaveBeenCalled(); // remote branch never touched
  });

  it('(b) REMOTE (isContainerized forced true): routes to RemoteTurnDispatcher.dispatch, not the engine', async () => {
    const run = vi.fn();
    const get = vi.fn(() => ({ name: EWorkerEngineName.CLAUDE, run }));
    const engines = { get } as unknown as EngineRegistry;
    const dispatch = vi.fn(async () => RESULT);
    const remote = { dispatch } as unknown as RemoteTurnDispatcher;

    const exec = new TestableTurnExecutor(engines, remote, true);
    const args = makeArgs();
    const out = await exec.run(CTX, EWorkerEngineName.CLAUDE, args);

    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(dispatch).toHaveBeenCalledWith(CTX, EWorkerEngineName.CLAUDE, args);
    expect(out).toBe(RESULT);
    expect(get).not.toHaveBeenCalled(); // local engine registry untouched on the remote path
    expect(run).not.toHaveBeenCalled();
  });

  it('isContainerized defaults OFF (the live hot path stays local this phase)', async () => {
    const run = vi.fn(async () => RESULT);
    const engines = {
      get: () => ({ name: EWorkerEngineName.CODEX, run }),
    } as unknown as EngineRegistry;
    const dispatch = vi.fn(async () => RESULT);
    const remote = { dispatch } as unknown as RemoteTurnDispatcher;

    const exec = new TurnExecutor(engines, remote, noSandboxes, noWorkAreas);
    await exec.run(CTX, EWorkerEngineName.CODEX, makeArgs());

    expect(run).toHaveBeenCalledTimes(1); // local
    expect(dispatch).not.toHaveBeenCalled(); // dormant remote
  });

  it('THE DISCRIMINATOR: routes REMOTE when the workArea resolves to a LIVE sandbox (real isContainerized)', async () => {
    const run = vi.fn(async () => RESULT);
    const engines = {
      get: () => ({ name: EWorkerEngineName.CLAUDE, run }),
    } as unknown as EngineRegistry;
    const dispatch = vi.fn(async () => RESULT);
    const remote = { dispatch } as unknown as RemoteTurnDispatcher;
    // The real policy: a workAreaId that resolves (via WorkspaceRegistry) to a live sandbox ⇒ remote.
    const has = vi.fn((id: string) => id === 'sandbox-uuid-1');
    const sandboxes = { has } as unknown as SandboxRegistry;
    const workAreas = new WorkspaceRegistry();
    workAreas.upsert({
      workAreaId: 'wa-1',
      sandboxId: 'sandbox-uuid-1',
      team: 't',
      project: 'p',
      name: 'wa-1',
      ownerBot: 'alex',
    });

    const exec = new TurnExecutor(engines, remote, sandboxes, workAreas);

    // A work area whose sandbox is live → remote.
    await exec.run(
      { team: 't', project: 'p', workspaceId: 'wa-1' },
      EWorkerEngineName.CLAUDE,
      makeArgs(),
    );
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(run).not.toHaveBeenCalled();

    // An unknown work area id (not in the registry) → local.
    dispatch.mockClear();
    await exec.run(
      { team: 't', project: 'p', workspaceId: 'wa-unknown' },
      EWorkerEngineName.CLAUDE,
      makeArgs(),
    );
    expect(run).toHaveBeenCalledTimes(1);
    expect(dispatch).not.toHaveBeenCalled();

    // No workspace id at all → local.
    run.mockClear();
    await exec.run(
      { team: 't', project: 'p' },
      EWorkerEngineName.CLAUDE,
      makeArgs(),
    );
    expect(run).toHaveBeenCalledTimes(1);
  });
});
