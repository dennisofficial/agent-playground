/**
 * Phase 7 — `RemoteTurnDispatcher` unit tests (DORMANT remote branch, fakes only).
 *
 * Asserts the dispatcher:
 *   - resolves the sandbox from the SESSION's OWN workspaceId (== the sandbox uuid) via
 *     `SandboxRegistry.get(sandboxId)` — NOT by `(team, project)` (a project has several per-branch
 *     workstations, so tenancy-resolve would dispatch to the wrong one);
 *   - resolves the agent's tool inputs via `AgentToolSourceResolver.forAgent(agentId)`;
 *   - builds the `RunCommandPayload` correctly: NO `cwd`/`onEvent`/`signal` (they don't cross the wire),
 *     the right `engine` string, `resumeSessionId` = the engine resume handle (`args.sessionId`),
 *     `sessionId` = the harness session id, and the resolved `skillSources`/`mcpServers`;
 *   - streams each event to the caller's `onEvent` and returns the daemon's result;
 *   - refuses langgraph (it stays host-side).
 *
 * `SandboxRegistry`, `AgentToolSourceResolver`, and `DaemonClient` are all fakes.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  EWorkerEngineName,
  type RunWorkerArgs,
  type WorkerEvent,
} from '../engines/worker-engine.port';
import type { AgentToolSourceResolver } from '../skills/agent-tool-source-resolver.service';
import type { McpServerConfig, SkillSource } from '../skills/skill.types';
import type { DaemonClient } from './daemon-client';
import type { RunCommandPayload } from './daemon-protocol';
import type { SandboxReadinessService } from './sandbox-readiness.service';
import type { SandboxRecord } from './sandbox-registry';
import type { SandboxRegistry } from './sandbox-registry';
import { RemoteTurnDispatcher } from './remote-turn.dispatcher';
import type { Session } from '../sessions/session-registry.port';
import type { TurnRoutingCtx } from './turn-executor.service';

const SANDBOX: SandboxRecord = {
  workspaceId: 'sandbox-uuid-123',
  team: 'team-1',
  project: 'proj-1',
  branch: 'feature/export-csv',
  baseRef: 'dev',
  upstream: 'dev',
  repo: 'https://github.com/acme/proj-1',
  containerId: 'container-abc',
  status: 'running',
};

const SKILLS: SkillSource[] = [
  { name: 'pdf', kind: 'local', path: 'skills/pdf' } as unknown as SkillSource,
];
const MCP: McpServerConfig[] = [
  { name: 'github' } as unknown as McpServerConfig,
];

function makeArgs(over: Partial<RunWorkerArgs> = {}): RunWorkerArgs {
  return {
    task: 'fix the bug',
    cwd: '/host/path/should/not/cross/the/wire',
    systemPrompt: 'you are alex',
    agentId: 'alex',
    sessionId: 'engine-resume-77', // the ENGINE's own resume handle
    model: 'claude-sonnet',
    effort: 'high',
    mode: 'execute',
    engineAuth: { mode: 'api_key', apiKey: 'sk-test' },
    onEvent: vi.fn(),
    signal: new AbortController().signal,
    ...over,
  };
}

function build(over: {
  get?: (id: string) => SandboxRecord | undefined;
  forAgent?: () => Promise<{
    skillSources: SkillSource[];
    mcpServers: McpServerConfig[];
  }>;
  dispatchRun?: DaemonClient['dispatchRun'];
  waitForReady?: () => Promise<void>;
} = {}) {
  // The dispatcher now looks the sandbox up by id (== session.workspaceId). Default: only the SANDBOX uuid
  // resolves; anything else is unknown (so a routing bug surfaces as a clear throw).
  const get = vi.fn(
    over.get ??
      ((id: string) => (id === SANDBOX.workspaceId ? SANDBOX : undefined)),
  );
  const sandboxes = { get } as unknown as SandboxRegistry;

  const forAgent = vi.fn(
    over.forAgent ?? (async () => ({ skillSources: SKILLS, mcpServers: MCP })),
  );
  const toolSources = { forAgent } as unknown as AgentToolSourceResolver;

  const dispatchRun = vi.fn(
    over.dispatchRun ??
      (async () => ({ result: 'shipped', sessionId: 'engine-next-88' })),
  ) as unknown as DaemonClient['dispatchRun'];
  const daemon = { dispatchRun } as unknown as DaemonClient;

  const waitForReady = vi.fn(over.waitForReady ?? (async () => undefined));
  const readiness = { waitForReady } as unknown as SandboxReadinessService;

  const dispatcher = new RemoteTurnDispatcher(
    sandboxes,
    toolSources,
    daemon,
    readiness,
  );
  return { dispatcher, get, forAgent, dispatchRun, waitForReady };
}

describe('RemoteTurnDispatcher.dispatch', () => {
  it('resolves the sandbox by the SESSION workspaceId + tool sources and builds the wire payload (no cwd/onEvent/signal)', async () => {
    const { dispatcher, get, forAgent, dispatchRun, waitForReady } = build();
    // session.workspaceId IS the sandbox uuid (1:1 workstation↔work-area). The dispatcher resolves THAT.
    const ctx: TurnRoutingCtx = {
      team: 'team-1',
      project: 'proj-1',
      workspaceId: 'unused-when-session-present',
      session: { id: 'sess-42', workspaceId: 'sandbox-uuid-123' } as Session,
    };
    const args = makeArgs();

    await dispatcher.dispatch(ctx, EWorkerEngineName.CLAUDE, args);

    // Resolved by the session's OWN workspaceId (== sandbox uuid), NOT by (team, project).
    expect(get).toHaveBeenCalledWith('sandbox-uuid-123');
    // The readiness gate is awaited on that sandbox uuid before the run is dispatched.
    expect(waitForReady).toHaveBeenCalledWith('sandbox-uuid-123');
    expect(forAgent).toHaveBeenCalledWith('alex');

    // dispatchRun(workspaceId, payload, onEvent, signal)
    expect(dispatchRun).toHaveBeenCalledTimes(1);
    const [workspaceId, payload, onEvent, signal] = (
      dispatchRun as unknown as { mock: { calls: unknown[][] } }
    ).mock.calls[0] as [string, RunCommandPayload, unknown, unknown];

    expect(workspaceId).toBe('sandbox-uuid-123'); // the resolved sandbox uuid

    // The payload carries the engine, the resolved sources, and the resume mapping.
    expect(payload).toEqual({
      engine: 'claude',
      workAreaId: 'sandbox-uuid-123', // 1:1 — the work area id == the sandbox id
      sessionId: 'sess-42', // the harness session id (per-session dev port + tracing)
      task: 'fix the bug',
      systemPrompt: 'you are alex',
      agentId: 'alex',
      resumeSessionId: 'engine-resume-77', // args.sessionId → engine resume handle
      model: 'claude-sonnet',
      effort: 'high',
      mode: 'execute',
      engineAuth: { mode: 'api_key', apiKey: 'sk-test' },
      skillSources: SKILLS,
      mcpServers: MCP,
    });
    // The three non-wire fields are absent from the payload.
    expect('cwd' in payload).toBe(false);
    expect('onEvent' in payload).toBe(false);
    expect('signal' in payload).toBe(false);

    // onEvent + signal are forwarded to the client (out-of-band, not in the payload).
    expect(onEvent).toBe(args.onEvent);
    expect(signal).toBe(args.signal);
  });

  it('maps codex and resolves a session-less ctx by ctx.workspaceId (the sandbox uuid)', async () => {
    const { dispatcher, dispatchRun } = build();
    // No session → ctx.workspaceId carries the sandbox uuid (e.g. review/self-review callers).
    const ctx: TurnRoutingCtx = {
      team: 'team-1',
      project: 'proj-1',
      workspaceId: 'sandbox-uuid-123',
    };
    await dispatcher.dispatch(ctx, EWorkerEngineName.CODEX, makeArgs());
    const payload = (dispatchRun as unknown as { mock: { calls: unknown[][] } })
      .mock.calls[0][1] as RunCommandPayload;
    expect(payload.engine).toBe('codex');
    expect(payload.workAreaId).toBe('sandbox-uuid-123'); // work area == sandbox id
    expect(payload.sessionId).toBe('sandbox-uuid-123'); // no session → workAreaId fallback for the id too
  });

  it('throws when the turn carries no workspaceId at all (no sandbox to resolve)', async () => {
    const { dispatcher, dispatchRun } = build();
    const ctx: TurnRoutingCtx = { team: 'team-1', project: 'proj-1' };
    await expect(
      dispatcher.dispatch(ctx, EWorkerEngineName.CLAUDE, makeArgs()),
    ).rejects.toThrow(/no workspaceId/i);
    expect(dispatchRun).not.toHaveBeenCalled();
  });

  it('throws when the workspaceId does not resolve to a known sandbox (gone workstation)', async () => {
    const { dispatcher, dispatchRun } = build();
    const ctx: TurnRoutingCtx = {
      team: 'team-1',
      project: 'proj-1',
      workspaceId: 'unknown-sandbox',
    };
    await expect(
      dispatcher.dispatch(ctx, EWorkerEngineName.CLAUDE, makeArgs()),
    ).rejects.toThrow(/no live sandbox/i);
    expect(dispatchRun).not.toHaveBeenCalled();
  });

  it('streams onEvent and returns the daemon result', async () => {
    const events: WorkerEvent[] = [];
    const seen: WorkerEvent[] = [];
    const dispatchRun = (async (
      _ws: string,
      _payload: RunCommandPayload,
      onEvent: (e: WorkerEvent) => void,
    ) => {
      for (const e of events) onEvent(e);
      return { result: 'final-report', sessionId: 'engine-next-88' };
    }) as unknown as DaemonClient['dispatchRun'];
    const { dispatcher } = build({ dispatchRun });

    events.push(
      { kind: 'text', text: 'thinking' },
      { kind: 'tool', name: 'Read' },
      { kind: 'result', text: 'final-report' },
    );

    const ctx: TurnRoutingCtx = {
      team: 'team-1',
      project: 'proj-1',
      workspaceId: 'sandbox-uuid-123',
    };
    const out = await dispatcher.dispatch(
      ctx,
      EWorkerEngineName.CLAUDE,
      makeArgs({ onEvent: (e) => seen.push(e) }),
    );

    expect(seen).toEqual(events); // every event streamed through to the caller's onEvent
    expect(out).toEqual({ result: 'final-report', sessionId: 'engine-next-88' });
  });

  it('does NOT dispatch the run when the readiness gate fails (sandbox never readied)', async () => {
    const { dispatcher, dispatchRun, waitForReady } = build({
      waitForReady: async () => {
        throw new Error('sandbox sandbox-uuid-123 did not signal ready');
      },
    });
    const ctx: TurnRoutingCtx = {
      team: 'team-1',
      project: 'proj-1',
      workspaceId: 'sandbox-uuid-123',
    };
    await expect(
      dispatcher.dispatch(ctx, EWorkerEngineName.CLAUDE, makeArgs()),
    ).rejects.toThrow(/did not signal ready/);
    expect(waitForReady).toHaveBeenCalledWith('sandbox-uuid-123');
    expect(dispatchRun).not.toHaveBeenCalled();
  });

  it('refuses langgraph (it stays host-side)', async () => {
    const { dispatcher, get } = build();
    const ctx: TurnRoutingCtx = {
      team: 'team-1',
      project: 'proj-1',
      workspaceId: 'sandbox-uuid-123',
    };
    await expect(
      dispatcher.dispatch(ctx, EWorkerEngineName.LANGGRAPH, makeArgs()),
    ).rejects.toThrow(/langgraph/i);
    expect(get).not.toHaveBeenCalled();
  });
});
