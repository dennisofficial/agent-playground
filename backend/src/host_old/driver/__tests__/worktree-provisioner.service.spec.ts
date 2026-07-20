import { describe, expect, it, vi } from 'vitest';
import type { PipelineAwarenessStore } from '../pipeline-awareness.store';
import type { WorktreeHydrator } from '../worktree-hydrator.service';
import { WorktreeProvisioner } from '../worktree-provisioner.service';

describe('WorktreeProvisioner.provisionAndAttach — onMilestone pass-through', () => {
  function makeProvisioner() {
    const hydrator = {
      resolveMounts: vi.fn(async () => []),
      computeSig: vi.fn(async () => 'sig-1'),
      hydrateFiles: vi.fn(async () => ({ forbiddenPaths: [], notices: [] })),
    } as unknown as WorktreeHydrator;
    const awareness = {
      appendMarker: vi.fn(async () => undefined),
    } as unknown as PipelineAwarenessStore;
    const config = {
      importLegacyIfEmpty: vi.fn(async () => undefined),
      getSetupScript: vi.fn(async () => null),
    } as unknown as import('../../onboarding/workspace-config.store').WorkspaceConfigStore;
    const attach = vi.fn(async () => ({
      repoId: 'proj',
      branch: 'main',
      worktreePath: '/wt',
      gitUrl: '',
    }));
    const kickMcpHubRefresh = vi.fn(async () => undefined);
    const sandboxProvider = {
      attach,
      kickMcpHubRefresh,
    } as unknown as import('../../sandbox/sandbox-provider.port').SandboxProvider;
    const resolveForSandbox = vi.fn(async () => [
      { name: 's', transport: 'http', url: 'https://s' },
    ]);
    const mcp = {
      resolveForSandbox,
    } as unknown as import('../../mcp/mcp-resolver.service').McpResolver;

    const provisioner = new WorktreeProvisioner(hydrator, awareness, config, mcp, sandboxProvider);
    return { provisioner, attach, kickMcpHubRefresh, resolveForSandbox };
  }

  it('threads onMilestone straight through to SandboxProvider.attach()', async () => {
    const { provisioner, attach } = makeProvisioner();
    const onMilestone = vi.fn();

    await provisioner.provisionAndAttach({
      sandbox: {
        repoId: 'proj',
        branch: 'main',
        worktreePath: '/wt',
        gitUrl: '',
      },
      orgId: 'org-1',
      jobId: 'job-1',
      onMilestone,
    });

    expect(attach).toHaveBeenCalledWith(expect.objectContaining({ onMilestone }));
  });

  it('passes onMilestone as undefined when the caller omits it (no crash, no phantom callback)', async () => {
    const { provisioner, attach } = makeProvisioner();

    await provisioner.provisionAndAttach({
      sandbox: {
        repoId: 'proj',
        branch: 'main',
        worktreePath: '/wt',
        gitUrl: '',
      },
      orgId: 'org-1',
      jobId: 'job-1',
    });

    expect(attach).toHaveBeenCalledWith(expect.objectContaining({ onMilestone: undefined }));
  });

  it('resolves user MCP servers by the repo UUID (repoDbId) — NOT the slug-valued sandbox.repoId — and pushes them to the hub', async () => {
    const { provisioner, kickMcpHubRefresh, resolveForSandbox } = makeProvisioner();

    await provisioner.provisionAndAttach({
      sandbox: {
        repoId: 'cubix-infra',
        branch: 'main',
        worktreePath: '/wt',
        gitUrl: '',
      },
      orgId: 'org-1',
      jobId: 'job-1',
      repoDbId: 'repo-uuid-1',
    });

    expect(resolveForSandbox).toHaveBeenCalledWith('org-1', 'repo-uuid-1');
    expect(kickMcpHubRefresh).toHaveBeenCalledWith({
      jobId: 'job-1',
      servers: [{ name: 's', transport: 'http', url: 'https://s' }],
    });
  });

  it('skips the hub refresh entirely when there is no repoDbId (no UUID → nothing to scope by)', async () => {
    const { provisioner, kickMcpHubRefresh, resolveForSandbox } = makeProvisioner();

    await provisioner.provisionAndAttach({
      sandbox: {
        repoId: 'proj',
        branch: 'main',
        worktreePath: '/wt',
        gitUrl: '',
      },
      orgId: 'org-1',
      jobId: 'job-1',
    });

    expect(resolveForSandbox).not.toHaveBeenCalled();
    expect(kickMcpHubRefresh).not.toHaveBeenCalled();
  });
});
