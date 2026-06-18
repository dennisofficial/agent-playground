/**
 * `create_workspace` CREATE-TIME POLICY: sandbox vs local.
 *
 *   sandbox  ⇔  WORKSPACE_SANDBOX_ENABLED === true && ProjectStore.get(team, project) exists
 *   local    ⇔  otherwise (the unchanged path — through the git port's local adapter)
 *
 * The sandbox path ensures the project's sandbox, then creates a durable WORK AREA inside it (a
 * branch/worktree its sessions share): it realizes the work-area worktree in the daemon
 * (`createWorktree(workAreaId, …)`) and registers a `WorkspaceRegistry` record. Verified with plain
 * fakes (no Nest, no Docker).
 */
import { describe, expect, it, vi } from 'vitest';
import type { EnvService } from '@core/config/env/env.service';
import type { ProjectStore } from '../../projects/project-store';
import type { ContainerManagerService } from '../../workspaces/container-manager.service';
import type { DaemonClient } from '../../workspaces/daemon-client';
import type { SandboxReadinessService } from '../../workspaces/sandbox-readiness.service';
import type { SandboxRecord } from '../../workspaces/sandbox-registry';
import { WorkspaceRegistry } from '../../workspaces/workspace-registry';
import type { WorkspaceService } from '../../workspaces/workspace.service';
import { localGitProvider } from '../../workspaces/workspace-git.test-util';
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

function build(opts: { flag?: boolean; registered?: boolean }) {
  const env = {
    get: (k: string) =>
      k === 'WORKSPACE_SANDBOX_ENABLED' ? (opts.flag ?? false) : undefined,
  } as unknown as EnvService;
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

  const create = vi.fn(async () => ({
    workspace: {
      id: 'ws-001',
      branch: 'agent/alex/ws-001-work',
      sharedBranch: undefined,
    },
  }));
  const localGit = { create } as unknown as WorkspaceService;
  const workspaceGit = localGitProvider(localGit as never);
  const workspaces = {} as unknown as WorkspaceService;
  const workAreas = new WorkspaceRegistry();
  const gitCall = vi.fn(async () => '/workspace/repo/.workspaces/wa');
  const daemon = { gitCall } as unknown as DaemonClient;
  const waitForReady = vi.fn(async () => undefined);
  const readiness = { waitForReady } as unknown as SandboxReadinessService;

  const tool = new CreateWorkspaceTool(
    workspaceGit,
    workspaces,
    containers,
    projects,
    env,
    workAreas,
    daemon,
    readiness,
  );
  return { tool, ensureWorkspace, create, workAreas, gitCall, waitForReady };
}

describe('create_workspace create-time policy', () => {
  it('flag ON + registered project → SANDBOX work area (realized in the daemon + registered)', async () => {
    const { tool, ensureWorkspace, create, workAreas, gitCall, waitForReady } =
      build({ flag: true, registered: true });
    const out = await tool.execute({ name: 'work' }, CTX);

    expect(ensureWorkspace).toHaveBeenCalledWith('T1', 'proj');
    expect(create).not.toHaveBeenCalled(); // no local checkout cut
    expect(waitForReady).toHaveBeenCalledWith('sandbox-uuid-1');

    // The work area's worktree is realized in the daemon, keyed by the new workAreaId.
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

    // A work-area record was registered, mapping the workAreaId to its sandbox.
    const rec = workAreas.get(workAreaId);
    expect(rec).toMatchObject({
      workAreaId,
      sandboxId: 'sandbox-uuid-1',
      team: 'T1',
      project: 'proj',
      name: 'work',
      ownerBot: 'alex',
    });
    expect(out).toContain(workAreaId);
  });

  it('flag OFF + registered project → LOCAL (the flag gates creation; no sandbox)', async () => {
    const { tool, ensureWorkspace, create } = build({
      flag: false,
      registered: true,
    });
    const out = await tool.execute({ name: 'work' }, CTX);
    expect(ensureWorkspace).not.toHaveBeenCalled();
    expect(create).toHaveBeenCalledTimes(1);
    expect(out).toContain('ws-001');
  });

  it('flag ON + UNregistered project → LOCAL (registered project is required for a sandbox)', async () => {
    const { tool, ensureWorkspace, create } = build({
      flag: true,
      registered: false,
    });
    const out = await tool.execute({ name: 'work' }, CTX);
    expect(ensureWorkspace).not.toHaveBeenCalled();
    expect(create).toHaveBeenCalledTimes(1);
    expect(out).toContain('ws-001');
  });
});
