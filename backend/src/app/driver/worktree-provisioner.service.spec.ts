import { describe, expect, it, vi } from 'vitest';
import type { LocalGitService } from '../git';
import type { PipelineAwarenessStore } from './pipeline-awareness.store';
import type { WorktreeHydrator } from './worktree-hydrator.service';
import { WorktreeProvisioner } from './worktree-provisioner.service';

/**
 * `provisionAndAttach` is a thin orchestrator (hydrate → attach); this spec covers only the ONE thing
 * worth protecting in isolation — that `onMilestone` (and the other attach-relevant fields) reach
 * `SandboxProvider.attach()` unchanged. Hydration/notice behavior is covered by `worktree-hydrator.service.spec.ts`.
 */
describe('WorktreeProvisioner.provisionAndAttach — onMilestone pass-through', () => {
  function makeProvisioner() {
    const hydrator = {
      resolveMounts: vi.fn(() => []),
      computeSig: vi.fn(async () => 'sig-1'),
      hydrateFiles: vi.fn(async () => ({ forbiddenPaths: [], notices: [] })),
    } as unknown as WorktreeHydrator;
    const awareness = { appendMarker: vi.fn(async () => undefined) } as unknown as PipelineAwarenessStore;
    const git = { ensureBuildJunkExcluded: vi.fn(async () => undefined) } as unknown as LocalGitService;
    const attach = vi.fn(async () => ({ repoId: 'proj', branch: 'main', worktreePath: '/wt', gitUrl: '' }));
    const sandboxProvider = { attach } as unknown as import('../sandbox').SandboxProvider;

    const provisioner = new WorktreeProvisioner(hydrator, awareness, git, sandboxProvider);
    return { provisioner, attach };
  }

  it('threads onMilestone straight through to SandboxProvider.attach()', async () => {
    const { provisioner, attach } = makeProvisioner();
    const onMilestone = vi.fn();

    await provisioner.provisionAndAttach({
      sandbox: { repoId: 'proj', branch: 'main', worktreePath: '/wt', gitUrl: '' },
      orgId: 'org-1',
      jobId: 'job-1',
      onMilestone,
    });

    expect(attach).toHaveBeenCalledWith(expect.objectContaining({ onMilestone }));
  });

  it('passes onMilestone as undefined when the caller omits it (no crash, no phantom callback)', async () => {
    const { provisioner, attach } = makeProvisioner();

    await provisioner.provisionAndAttach({
      sandbox: { repoId: 'proj', branch: 'main', worktreePath: '/wt', gitUrl: '' },
      orgId: 'org-1',
      jobId: 'job-1',
    });

    expect(attach).toHaveBeenCalledWith(expect.objectContaining({ onMilestone: undefined }));
  });
});
