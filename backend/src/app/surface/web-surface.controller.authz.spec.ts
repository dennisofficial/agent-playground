import { NotFoundException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import type { CurrentOrgCtx } from '../org/current-org.decorator';
import { WebSurfaceController } from './web-surface.controller';

/**
 * Cross-tenant isolation regression (the hole Codex flagged): `OrgMembershipGuard` only proves the
 * caller is a member of `:orgId`, but thread-keyed ops act on a `jobId`. Without scoping, a member of
 * ANY org with a leaked thread id could read/write/archive another org's thread — reclaiming that
 * tenant's worktree/container. `requireThread(jobId, org.id)` closes it: every thread-keyed op resolves
 * the thread scoped to the caller's org or 404s. (The web DELETE now ARCHIVES rather than hard-deletes.)
 *
 * Pure unit test — the controller is instantiated with mocked repos; `threads.findOne` returns a row only
 * when its `org_id` matches, emulating the scoped query.
 */
function makeController(threadOrgId: string) {
  const archiveJobDeep = vi.fn(async () => undefined);
  const claimArchiveJob = vi.fn(async () => true);
  const threads = {
    findOne: vi.fn(
      async ({ where }: { where: { id: string; org_id: string } }) =>
        where.org_id === threadOrgId
          ? { id: where.id, org_id: threadOrgId, repo_id: 'repo-1' }
          : null,
    ),
    delete: vi.fn(async () => ({ affected: 1 })),
  };
  const messages = {
    find: vi.fn(async () => []),
    delete: vi.fn(async () => undefined),
  };

  const controller = new WebSurfaceController(
    {} as never, // surface
    {} as never, // liveTurns
    {} as never, // driverStore
    { archiveJobDeep, claimArchiveJob } as never, // threadLifecycle
    {} as never, // autoMerge
    {} as never, // orgService
    threads as never,
    messages as never,
    {} as never, // repos
    {} as never, // subagents
    {} as never, // threadTitle
    {} as never, // usageBus
    { available: false } as never, // realtime
    {
      isLeader: () => true,
      getState: () => 'leader',
      isDraining: () => false,
    } as never, // election
    { dispatch: async () => undefined } as never, // dispatcher (JOB_DISPATCHER)
    {
      write: async () => undefined,
      list: async () => [],
      listForRepo: async () => [],
      read: async () => null,
    } as never, // secrets (WorkspaceSecretFileStore)
    {} as never, // store (BrainStoreService)
    { stopTurn: async () => false } as never, // brain (AgentSessionManager)
    {} as never, // mcpStore (McpServerStore)
    {} as never, // mcpProbe (McpProbeService)
    {} as never, // conventions (ConventionProfileResolver)
    {} as never, // skillStore (WorkspaceSkillStore)
    {} as never, // skillFiles (SkillFileWriter)
    {} as never, // skillInstaller (SkillInstallerService)
    {} as never, // git (LocalGitService)
    {} as never, // jobDeps (JobDependencyService)
    {} as never, // moduleRef (ModuleRef)
    {} as never, // intake (StimulusIntake)
  );
  return { controller, archiveJobDeep, claimArchiveJob, threads, messages };
}

describe('WebSurfaceController — cross-tenant authz', () => {
  const orgB: CurrentOrgCtx = { id: 'orgB', role: 'owner' };

  it("deleteThread on another org's thread 404s and never archives it", async () => {
    const { controller, archiveJobDeep, claimArchiveJob } =
      makeController('orgA'); // thread belongs to org A
    await expect(
      controller.deleteThread(orgB, 'leaked-thread-id'),
    ).rejects.toBeInstanceOf(NotFoundException);
    // 404s at requireThread — never claims nor reclaims.
    expect(claimArchiveJob).not.toHaveBeenCalled();
    expect(archiveJobDeep).not.toHaveBeenCalled();
  });

  it("messageHistory on another org's thread 404s and never reads messages", async () => {
    const { controller, messages } = makeController('orgA');
    await expect(
      controller.messageHistory(orgB, 'leaked-thread-id'),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(messages.find).not.toHaveBeenCalled();
  });

  it("deleteThread on the caller's OWN thread proceeds (org-scoped archive)", async () => {
    const { controller, archiveJobDeep, claimArchiveJob } =
      makeController('orgB'); // thread belongs to org B
    await controller.deleteThread(orgB, 'my-thread-id');
    // Claims the archive (durable `archived` state), then backgrounds the org-scoped filesystem reclaim.
    expect(claimArchiveJob).toHaveBeenCalledWith('my-thread-id', 'orgB');
    expect(archiveJobDeep).toHaveBeenCalledWith('my-thread-id', 'orgB');
  });
});
