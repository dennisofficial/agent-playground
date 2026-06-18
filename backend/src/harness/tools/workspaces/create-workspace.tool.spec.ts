/**
 * `create_workspace` CREATE-TIME POLICY (no flag — sandbox is the standard).
 *
 *   registered project   → SANDBOX work area (ensure the sandbox, realize the work-area worktree in the
 *                           daemon, register a WorkspaceRegistry record).
 *   unregistered project → REFUSE (a sandbox needs a clone URL; there is no local fallback).
 *
 * Verified with plain fakes (no Nest, no Docker).
 */
import { describe, expect, it, vi } from 'vitest';
import type { ProjectStore } from '../../projects/project-store';
import type { ContainerManagerService } from '../../workspaces/container-manager.service';
import type { DaemonClient } from '../../workspaces/daemon-client';
import type { SandboxReadinessService } from '../../workspaces/sandbox-readiness.service';
import type { SandboxRecord } from '../../workspaces/sandbox-registry';
import { WorkspaceRegistry } from '../../workspaces/workspace-registry';
import type { HarnessToolContext } from '../tool.types';
import { CreateWorkspaceTool } from './workspace.tools';

const CTX = {
  identity: {
    selfAgent: 'alex',
    team: 'T1',
    project: 'proj',
    surface: 'chan',
  },
} as unknown as HarnessToolContext;

function build(opts: { registered?: boolean }) {
  const projects = {
    get: vi.fn(async () =>
      opts.registered ? ({ projectId: 'proj' } as never) : undefined,
    ),
  } as unknown as ProjectStore;

  const ensureWorkspace = vi.fn(
    async (): Promise<SandboxRecord> => ({
      workspaceId: 'sandbox-uuid-1',
      team: 'T1',
      project: 'proj',
      repo: 'https://github.com/d/proj',
      containerId: 'c1',
      status: 'running',
    }),
  );
  const containers = { ensureWorkspace } as unknown as ContainerManagerService;
  const workAreas = new WorkspaceRegistry();
  const gitCall = vi.fn(async () => '/workspace/repo/.workspaces/wa');
  const daemon = { gitCall } as unknown as DaemonClient;
  const waitForReady = vi.fn(async () => undefined);
  const readiness = { waitForReady } as unknown as SandboxReadinessService;

  const tool = new CreateWorkspaceTool(
    containers,
    projects,
    workAreas,
    daemon,
    readiness,
  );
  return { tool, ensureWorkspace, workAreas, gitCall, waitForReady };
}

describe('create_workspace create-time policy (containerized standard)', () => {
  it('registered project → SANDBOX work area (realized in the daemon + registered)', async () => {
    const { tool, ensureWorkspace, workAreas, gitCall, waitForReady } = build({
      registered: true,
    });
    const out = await tool.execute({ name: 'work' }, CTX);

    expect(ensureWorkspace).toHaveBeenCalledWith('T1', 'proj');
    expect(waitForReady).toHaveBeenCalledWith('sandbox-uuid-1');

    expect(gitCall).toHaveBeenCalledTimes(1);
    const [sandboxId, method, args] = gitCall.mock.calls[0] as unknown as [
      string,
      string,
      unknown[],
    ];
    expect(sandboxId).toBe('sandbox-uuid-1');
    expect(method).toBe('createWorktree');
    const [workAreaId, realizeOpts] = args as [string, { ownerBot: string }];
    expect(workAreaId).toMatch(/^wa-/);
    expect(realizeOpts.ownerBot).toBe('alex');

    expect(workAreas.get(workAreaId)).toMatchObject({
      workAreaId,
      sandboxId: 'sandbox-uuid-1',
      team: 'T1',
      project: 'proj',
      name: 'work',
      ownerBot: 'alex',
    });
    expect(out).toContain(workAreaId);
  });

  it('unregistered project → REFUSE (no clone URL, no local fallback)', async () => {
    const { tool, ensureWorkspace, gitCall } = build({ registered: false });
    const out = await tool.execute({ name: 'work' }, CTX);
    expect(ensureWorkspace).not.toHaveBeenCalled();
    expect(gitCall).not.toHaveBeenCalled();
    expect(out).toMatch(/no registered GitHub repo|register the project/i);
  });
});
