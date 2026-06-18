/**
 * Phase 7 — `RemoteTurnDispatcher` unit tests (DORMANT remote branch, fakes only).
 *
 * Asserts the dispatcher:
 *   - resolves (lazily ensures) the sandbox via `SandboxRegistry.resolveForSession({team,project})`;
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
import type { SandboxRecord } from './sandbox-registry';
import type { SandboxRegistry } from './sandbox-registry';
import { RemoteTurnDispatcher } from './remote-turn.dispatcher';
import type { Session } from '../sessions/session-registry.port';
import type { TurnRoutingCtx } from './turn-executor.service';

const SANDBOX: SandboxRecord = {
  workspaceId: 'sandbox-uuid-123',
  team: 'team-1',
  project: 'proj-1',
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
    apiKey: 'sk-test',
    onEvent: vi.fn(),
    signal: new AbortController().signal,
    ...over,
  };
}

function build(over: {
  resolveForSession?: () => Promise<SandboxRecord>;
  forAgent?: () => Promise<{
    skillSources: SkillSource[];
    mcpServers: McpServerConfig[];
  }>;
  dispatchRun?: DaemonClient['dispatchRun'];
} = {}) {
  const resolveForSession = vi.fn(
    over.resolveForSession ?? (async () => SANDBOX),
  );
  const sandboxes = { resolveForSession } as unknown as SandboxRegistry;

  const forAgent = vi.fn(
    over.forAgent ?? (async () => ({ skillSources: SKILLS, mcpServers: MCP })),
  );
  const toolSources = { forAgent } as unknown as AgentToolSourceResolver;

  const dispatchRun = vi.fn(
    over.dispatchRun ??
      (async () => ({ result: 'shipped', sessionId: 'engine-next-88' })),
  ) as unknown as DaemonClient['dispatchRun'];
  const daemon = { dispatchRun } as unknown as DaemonClient;

  const dispatcher = new RemoteTurnDispatcher(sandboxes, toolSources, daemon);
  return { dispatcher, resolveForSession, forAgent, dispatchRun };
}

describe('RemoteTurnDispatcher.dispatch', () => {
  it('resolves the sandbox + tool sources and builds the wire payload (no cwd/onEvent/signal)', async () => {
    const { dispatcher, resolveForSession, forAgent, dispatchRun } = build();
    const ctx: TurnRoutingCtx = {
      team: 'team-1',
      project: 'proj-1',
      workspaceId: 'ws-001',
      session: { id: 'sess-42' } as Session,
    };
    const args = makeArgs();

    await dispatcher.dispatch(ctx, EWorkerEngineName.CLAUDE, args);

    expect(resolveForSession).toHaveBeenCalledWith({
      team: 'team-1',
      project: 'proj-1',
    });
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
      sessionId: 'sess-42', // harness session id (worktree key)
      task: 'fix the bug',
      systemPrompt: 'you are alex',
      agentId: 'alex',
      resumeSessionId: 'engine-resume-77', // args.sessionId → engine resume handle
      model: 'claude-sonnet',
      effort: 'high',
      mode: 'execute',
      apiKey: 'sk-test',
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

  it('maps codex and falls back to the workspaceId for the harness session id when no session', async () => {
    const { dispatcher, dispatchRun } = build();
    const ctx: TurnRoutingCtx = {
      team: 'team-1',
      project: 'proj-1',
      workspaceId: 'ws-009',
    };
    await dispatcher.dispatch(ctx, EWorkerEngineName.CODEX, makeArgs());
    const payload = (dispatchRun as unknown as { mock: { calls: unknown[][] } })
      .mock.calls[0][1] as RunCommandPayload;
    expect(payload.engine).toBe('codex');
    expect(payload.sessionId).toBe('ws-009'); // ctx.workspaceId fallback
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

    const ctx: TurnRoutingCtx = { team: 'team-1', project: 'proj-1' };
    const out = await dispatcher.dispatch(
      ctx,
      EWorkerEngineName.CLAUDE,
      makeArgs({ onEvent: (e) => seen.push(e) }),
    );

    expect(seen).toEqual(events); // every event streamed through to the caller's onEvent
    expect(out).toEqual({ result: 'final-report', sessionId: 'engine-next-88' });
  });

  it('refuses langgraph (it stays host-side)', async () => {
    const { dispatcher, resolveForSession } = build();
    const ctx: TurnRoutingCtx = { team: 'team-1', project: 'proj-1' };
    await expect(
      dispatcher.dispatch(ctx, EWorkerEngineName.LANGGRAPH, makeArgs()),
    ).rejects.toThrow(/langgraph/i);
    expect(resolveForSession).not.toHaveBeenCalled();
  });
});
