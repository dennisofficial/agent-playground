/**
 * `create_workspace` STRUCTURED-INTENT flow (workstations model — per-branch sandbox).
 *
 *   registered project   → derive the branch from {kind, slug?, ticket?} + the project's branching policy,
 *                           ensure (or re-enter) the per-branch WORKSTATION, register a work area whose id
 *                           IS the sandbox uuid (1:1).
 *   unregistered project → REFUSE (a sandbox needs a clone URL; there is no local fallback).
 *   auto-base            → calls pickAutoBase only when a rule for the intent uses 'auto'.
 *
 * Verified with plain fakes (no Nest, no Docker, no GitHub).
 */
import { describe, expect, it, vi } from 'vitest';
import type { ChannelRegistryService } from '../../channel/channel-registry.service';
import type { GithubApiService } from '../../projects/github-api.service';
import type { GithubTokenStore } from '../../projects/github-token-store';
import type { ProjectStore } from '../../projects/project-store';
import type { ContainerManagerService } from '../../workspaces/container-manager.service';
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

function build(opts: {
  registered?: boolean;
  liveProject?: string;
  defaultBranch?: string;
  autoBase?: string;
  /** Override the project's branching policy (default = the DEFAULT policy, feature off auto). */
  branchingPolicy?: unknown;
}) {
  const projects = {
    get: vi.fn(async () =>
      opts.registered
        ? ({
            teamId: 'T1',
            projectId: opts.liveProject ?? 'proj',
            gitUrl: 'https://github.com/d/proj',
            defaultBranch: opts.defaultBranch ?? 'main',
            branchingPolicy: opts.branchingPolicy ?? null,
            tokenName: null,
          } as never)
        : undefined,
    ),
  } as unknown as ProjectStore;

  const resolve = vi.fn(async () => ({ name: 'default', token: 'ghp_x' }));
  const tokens = { resolve } as unknown as GithubTokenStore;

  const pickAutoBase = vi.fn(async () => opts.autoBase ?? 'dev');
  const listBranches = vi.fn(async () => []);
  const github = { pickAutoBase, listBranches } as unknown as GithubApiService;

  // The live channel→project resolution. Existing tests use a non-channel CTX (isChannel falsy), so
  // projectOf is not consulted; the live-resolve test passes a channel CTX to exercise it.
  const projectOf = vi.fn((_surface: string) => opts.liveProject ?? 'proj');
  const channels = { projectOf } as unknown as ChannelRegistryService;

  const ensureWorkspace = vi.fn(
    async (
      _team: string,
      _project: string,
      branch: string,
      baseRef: string,
      upstream: string,
    ): Promise<SandboxRecord> => ({
      workspaceId: 'sandbox-uuid-1',
      team: 'T1',
      project: 'proj',
      branch,
      baseRef,
      upstream,
      repo: 'https://github.com/d/proj',
      containerId: 'c1',
      status: 'running',
    }),
  );
  const containers = { ensureWorkspace } as unknown as ContainerManagerService;
  const workAreas = new WorkspaceRegistry();

  const tool = new CreateWorkspaceTool(
    containers,
    projects,
    tokens,
    github,
    workAreas,
    channels,
  );
  return {
    tool,
    ensureWorkspace,
    workAreas,
    pickAutoBase,
    resolve,
    projectOf,
  };
}

describe('create_workspace structured-intent flow (workstations)', () => {
  it('feature intent → derives feature/<slug> off the auto-base and ensures the per-branch workstation', async () => {
    const { tool, ensureWorkspace, workAreas, pickAutoBase } = build({
      registered: true,
      autoBase: 'dev',
    });
    const out = await tool.execute({ kind: 'feature', slug: 'export csv' }, CTX);

    // The default feature rule uses 'auto' → pickAutoBase consulted.
    expect(pickAutoBase).toHaveBeenCalledTimes(1);
    // ensureWorkspace(team, project, branch, baseRef, upstream) — branch derived, base = auto.
    expect(ensureWorkspace).toHaveBeenCalledWith(
      'T1',
      'proj',
      'feature/export-csv',
      'dev',
      'dev',
    );

    // The work area id == the sandbox uuid (1:1), registered with the branch facts.
    expect(workAreas.get('sandbox-uuid-1')).toMatchObject({
      workAreaId: 'sandbox-uuid-1',
      sandboxId: 'sandbox-uuid-1',
      team: 'T1',
      project: 'proj',
      branch: 'feature/export-csv',
      baseRef: 'dev',
      upstream: 'dev',
      ownerBot: 'alex',
    });
    expect(out).toContain('feature/export-csv');
    expect(out).toContain('sandbox-uuid-1');
  });

  it('idempotent re-entry: a second feature call with the same slug reuses the same workstation', async () => {
    const { tool, ensureWorkspace } = build({ registered: true });
    await tool.execute({ kind: 'feature', slug: 'a' }, CTX);
    await tool.execute({ kind: 'feature', slug: 'a' }, CTX);
    // Both derive feature/a → the SAME ensureWorkspace key (the container layer dedups on it).
    expect(ensureWorkspace).toHaveBeenCalledTimes(2);
    expect(ensureWorkspace.mock.calls[0][2]).toBe('feature/a');
    expect(ensureWorkspace.mock.calls[1][2]).toBe('feature/a');
  });

  it('hotfix intent → hotfix/<ticket> off the default branch, NO auto-base lookup', async () => {
    const { tool, ensureWorkspace, pickAutoBase } = build({
      registered: true,
      defaultBranch: 'main',
    });
    await tool.execute({ kind: 'hotfix', ticket: 'BUG-9' }, CTX);
    // The default hotfix rule cuts from {default} / PRs into {default} — no 'auto' → no GitHub round-trip.
    expect(pickAutoBase).not.toHaveBeenCalled();
    expect(ensureWorkspace).toHaveBeenCalledWith(
      'T1',
      'proj',
      'hotfix/bug-9',
      'main',
      'main',
    );
  });

  it('base intent → works the base branch itself (no slug needed)', async () => {
    const { tool, ensureWorkspace } = build({
      registered: true,
      autoBase: 'dev',
    });
    await tool.execute({ kind: 'base' }, CTX);
    // base rule: name = {from} (the resolved base), upstream = {default}.
    expect(ensureWorkspace).toHaveBeenCalledWith('T1', 'proj', 'dev', 'dev', 'main');
  });

  it('unregistered project → REFUSE (no clone URL, no local fallback)', async () => {
    const { tool, ensureWorkspace } = build({ registered: false });
    const out = await tool.execute({ kind: 'feature', slug: 'x' }, CTX);
    expect(ensureWorkspace).not.toHaveBeenCalled();
    expect(out).toMatch(/no registered GitHub repo|register the project/i);
  });

  it('resolves the project LIVE from the channel registry, not the frozen identity', async () => {
    const { tool, ensureWorkspace, projectOf } = build({
      registered: true,
      liveProject: 'linked-repo',
    });
    const ctx = {
      identity: {
        selfAgent: 'atlas',
        team: 'T1',
        project: 'old-slug',
        surface: 'slack:T1:C1',
        isChannel: true,
      },
    } as unknown as HarnessToolContext;
    await tool.execute({ kind: 'feature', slug: 'x' }, ctx);
    expect(projectOf).toHaveBeenCalledWith('slack:T1:C1');
    expect(ensureWorkspace).toHaveBeenCalledWith(
      'T1',
      'linked-repo',
      'feature/x',
      'dev',
      'dev',
    );
  });
});
