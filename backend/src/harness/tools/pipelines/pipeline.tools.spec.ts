import { DispatchPipelineTool } from './pipeline.tools';
import type { HarnessToolContext } from '../tool.types';

/**
 * The dispatch_pipeline SOFT grounding guard (Phase 1): a feature dispatch should trace to a real
 * code read — an `investigate` session tied to the board task — not a memory/assumption decomposition.
 * The guard is a helpful refusal (a returned string, never a throw), overridable with
 * `acknowledge_ungrounded`, and never applied to a bugfix.
 */

const ctx = {
  identity: {
    selfAgent: 'atlas',
    team: 'T1',
    project: 'proj',
    surface: 'chan',
  },
} as unknown as HarnessToolContext;

function makeTool(sessions: unknown[]) {
  const start = vi.fn(() => Promise.resolve({}));
  const board = { get: vi.fn(() => Promise.resolve({ project: 'proj' })) };
  const workspaces = { get: vi.fn(() => ({ id: 'ws-1' })) };
  const employees = { byId: vi.fn((id: string) => ({ id })) };
  const runner = { start };
  const sessionsReg = { list: vi.fn(() => Promise.resolve(sessions)) };
  const tool = new DispatchPipelineTool(
    board as never,
    workspaces as never,
    employees as never,
    runner as never,
    sessionsReg as never,
  );
  return { tool, start, sessionsReg };
}

const featureArgs = {
  board_task_id: 5,
  workspace_id: 'ws-1',
  kind: 'feature' as const,
  sections: [{ name: 'backend', role: 'phase_backend' }],
};

describe('dispatch_pipeline grounding guard', () => {
  it('refuses a feature with no investigate tied to the task (and starts nothing)', async () => {
    const { tool, start } = makeTool([]);
    const out = await tool.execute(featureArgs, ctx);
    expect(out).toContain('investigate');
    expect(out).toContain('bugfix');
    expect(start).not.toHaveBeenCalled();
  });

  it('dispatches a feature when an idle investigate session is tied to the task', async () => {
    const { tool, start } = makeTool([
      { boardTaskId: 5, mode: 'investigate', status: 'idle' },
    ]);
    await tool.execute(featureArgs, ctx);
    expect(start).toHaveBeenCalledTimes(1);
  });

  it('counts a still-running investigate as grounding', async () => {
    const { tool, start } = makeTool([
      { boardTaskId: 5, mode: 'investigate', status: 'running' },
    ]);
    await tool.execute(featureArgs, ctx);
    expect(start).toHaveBeenCalledTimes(1);
  });

  it('ignores an investigate for a different task or a non-investigate session', async () => {
    const { tool, start } = makeTool([
      { boardTaskId: 9, mode: 'investigate', status: 'idle' },
      { boardTaskId: 5, mode: 'execute', status: 'running' },
    ]);
    const out = await tool.execute(featureArgs, ctx);
    expect(out).toContain('investigate');
    expect(start).not.toHaveBeenCalled();
  });

  it('never guards a bugfix', async () => {
    const { tool, start } = makeTool([]);
    await tool.execute(
      {
        board_task_id: 5,
        workspace_id: 'ws-1',
        kind: 'bugfix',
        role: 'phase_backend',
      },
      ctx,
    );
    expect(start).toHaveBeenCalledTimes(1);
  });
});
