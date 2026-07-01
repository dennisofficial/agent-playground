/**
 * Unit tests for `JobLifecycleService.rowToSandbox` (accessed via a cast to bypass `private`).
 *
 * Verifies: `execUser` is recomputed from the host process uid:gid when the persisted row has a
 * `container_id` (docker mode) and absent otherwise; and that the branch is sourced from the THREAD
 * (feature_branch → base_branch) while the on-disk repo identity is the repo's SLUG — the sandbox row
 * itself no longer carries the branch (single owner = the thread).
 *
 * No DB, no Docker — all TypeORM repositories are mocked stubs.
 */

import type { EnvService } from '@core/config/env/env.service';
import type { ModuleRef } from '@nestjs/core';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { Repository } from 'typeorm';
import type {
  RepoEntity,
  JobEntity,
  JobSandboxEntity,
} from '../persistence/entities';
import type { GithubPrService, LocalGitService } from '../git';
import type { CredentialResolver } from '../onboarding';
import type { DriverRepoResolver } from './repo-resolver';
import { SandboxActivityRegistry, type SandboxProvider } from '../sandbox';
import { JobLifecycleService } from './job-lifecycle.service';
import type { TicketService } from '../tickets';
import type { WorktreeProvisioner } from './worktree-provisioner.service';

// ── helpers ─────────────────────────────────────────────────────────────────────────────────────

/** Build a bare-minimum JobSandboxEntity row (infra-only — no branch/PR; those live on the thread). */
function makeRow(overrides: Partial<JobSandboxEntity> = {}): JobSandboxEntity {
  return {
    id: 'sandbox-1',
    org_id: 'T1',
    job_id: 'thread-1',
    repo_id: 'repo-uuid-1',
    worktree_path: '/repos/proj/.worktrees/thread-1',
    container_id: null,
    lifecycle: 'attached',
    session_id: null,
    last_active_at: null,
    created_at: new Date(),
    updated_at: new Date(),
    ...overrides,
  } as JobSandboxEntity;
}

/**
 * Construct a JobLifecycleService whose `threads`/`projects` repos return the given thread + repo, so
 * `rowToSandbox` can resolve the branch (from the thread) and the on-disk slug (from the repo).
 */
function makeService(
  thread: Partial<JobEntity> = {},
  repo: Partial<RepoEntity> = {},
): JobLifecycleService {
  const threadRow = { id: 'thread-1', feature_branch: null, base_branch: 'main', ...thread };
  const repoRow = { id: 'repo-uuid-1', slug: 'proj', default_branch: 'main', ...repo };
  const threads = { findOne: vi.fn().mockResolvedValue(threadRow) } as unknown as Repository<JobEntity>;
  const projects = { findOne: vi.fn().mockResolvedValue(repoRow) } as unknown as Repository<RepoEntity>;
  const sandboxes = { findOne: vi.fn(), save: vi.fn(), create: vi.fn() } as unknown as Repository<JobSandboxEntity>;

  return new JobLifecycleService(
    threads,
    sandboxes,
    projects,
    {} as unknown as LocalGitService,
    { getPullState: vi.fn() } as unknown as GithubPrService,
    { githubToken: vi.fn() } as unknown as CredentialResolver,
    { get: vi.fn() } as unknown as EnvService,
    new SandboxActivityRegistry(),
    { resolve: vi.fn() } as unknown as DriverRepoResolver,
    { attach: vi.fn(), teardown: vi.fn(), teardownByIdentity: vi.fn() } as unknown as SandboxProvider,
    { provisionAndAttach: vi.fn() } as unknown as WorktreeProvisioner,
    { revertForDeletedThread: vi.fn() } as unknown as TicketService,
    { get: vi.fn() } as unknown as ModuleRef,
  );
}

/** Build a service whose sandbox repo + provisioner are controllable, for rehydrateThread tests. */
function makeServiceWithMocks(row: JobSandboxEntity | null, hydrationSig = 'new') {
  const sandboxes = {
    findOne: vi.fn().mockResolvedValue(row),
    save: vi.fn(),
    create: vi.fn(),
  } as unknown as Repository<JobSandboxEntity>;
  const provisionAndAttach = vi.fn().mockResolvedValue({
    sandbox: { worktreePath: row?.worktree_path, containerId: 'c1', repoId: 'proj', branch: 'main' },
    hydrationSig,
  });
  const svc = new JobLifecycleService(
    { findOne: vi.fn().mockResolvedValue({ id: 'thread-1', feature_branch: null, base_branch: 'main' }) } as unknown as Repository<JobEntity>,
    sandboxes,
    { findOne: vi.fn().mockResolvedValue({ id: 'repo-uuid-1', slug: 'proj', default_branch: 'main' }) } as unknown as Repository<RepoEntity>,
    {} as unknown as LocalGitService,
    { getPullState: vi.fn() } as unknown as GithubPrService,
    { githubToken: vi.fn() } as unknown as CredentialResolver,
    { get: vi.fn() } as unknown as EnvService,
    new SandboxActivityRegistry(),
    { resolve: vi.fn() } as unknown as DriverRepoResolver,
    { attach: vi.fn(), teardown: vi.fn(), teardownByIdentity: vi.fn() } as unknown as SandboxProvider,
    { provisionAndAttach } as unknown as WorktreeProvisioner,
    { revertForDeletedThread: vi.fn() } as unknown as TicketService,
    { get: vi.fn() } as unknown as ModuleRef,
  );
  return { svc, sandboxes, provisionAndAttach };
}

// Cast to access the private (now-async) rowToSandbox method from tests.
function rowToSandbox(svc: JobLifecycleService, row: JobSandboxEntity) {
  return (
    svc as unknown as {
      rowToSandbox(r: JobSandboxEntity): Promise<import('../git').FeatureSandbox>;
    }
  ).rowToSandbox(row);
}

// ── tests ────────────────────────────────────────────────────────────────────────────────────────

describe('JobLifecycleService.rowToSandbox', () => {
  it('populates execUser with the host uid:gid for a row WITH a container_id (docker mode)', async () => {
    const svc = makeService();
    const row = makeRow({ container_id: 'abc123def456' });

    const sandbox = await rowToSandbox(svc, row);

    // containerId must be propagated.
    expect(sandbox).toMatchObject({ containerId: 'abc123def456' });

    // execUser must be recomputed — on Linux/macOS process.getuid/getgid are available.
    const uid = typeof process.getuid === 'function' ? process.getuid() : undefined;
    const gid = typeof process.getgid === 'function' ? process.getgid() : undefined;

    if (uid !== undefined && gid !== undefined) {
      expect(sandbox.execUser).toBe(`${uid}:${gid}`);
    } else {
      // On platforms without uid/gid (e.g. Windows CI), the field must be absent.
      expect(sandbox.execUser).toBeUndefined();
    }
  });

  it('omits execUser for a row WITHOUT a container_id (local mode)', async () => {
    const svc = makeService();
    const row = makeRow({ container_id: null });

    const sandbox = await rowToSandbox(svc, row);

    expect(sandbox.containerId).toBeUndefined();
    expect(sandbox.execUser).toBeUndefined();
  });

  it('uses the on-disk repo SLUG as the sandbox repoId', async () => {
    const svc = makeService({}, { slug: 'my-repo' });
    const sandbox = await rowToSandbox(svc, makeRow({ container_id: 'x' }));
    expect(sandbox.repoId).toBe('my-repo');
  });

  it('uses the thread feature_branch when set, falls back to base_branch', async () => {
    const branched = await rowToSandbox(
      makeService({ feature_branch: 'atlas/feature-abc', base_branch: 'main' }),
      makeRow({ container_id: 'x' }),
    );
    expect(branched.branch).toBe('atlas/feature-abc');

    const base = await rowToSandbox(
      makeService({ feature_branch: null, base_branch: 'main' }),
      makeRow({ container_id: 'x' }),
    );
    expect(base.branch).toBe('main');
  });
});

describe('JobLifecycleService.rehydrateThread', () => {
  it('force-hydrates the live worktree and persists the new signature', async () => {
    const wt = mkdtempSync(join(tmpdir(), 'atlas-rehy-'));
    try {
      const row = makeRow({ worktree_path: wt, hydration_sig: 'old' } as Partial<JobSandboxEntity>);
      const { svc, sandboxes, provisionAndAttach } = makeServiceWithMocks(row, 'new-sig');

      const ok = await svc.rehydrateThread('thread-1', 'T1');

      expect(ok).toBe(true);
      expect(provisionAndAttach).toHaveBeenCalledWith(
        expect.objectContaining({ forceHydrate: true, jobId: 'thread-1', orgId: 'T1' }),
      );
      expect(sandboxes.save).toHaveBeenCalled();
      expect((row as JobSandboxEntity).hydration_sig).toBe('new-sig');
    } finally {
      rmSync(wt, { recursive: true, force: true });
    }
  });

  it('is a no-op (false) when the worktree is gone — the next real turn hydrates it', async () => {
    const row = makeRow({ worktree_path: '/atlas/does-not-exist/thread-1' });
    const { svc, provisionAndAttach } = makeServiceWithMocks(row);
    expect(await svc.rehydrateThread('thread-1', 'T1')).toBe(false);
    expect(provisionAndAttach).not.toHaveBeenCalled();
  });

  it('is a no-op (false) when there is no sandbox row', async () => {
    const { svc, provisionAndAttach } = makeServiceWithMocks(null);
    expect(await svc.rehydrateThread('thread-1', 'T1')).toBe(false);
    expect(provisionAndAttach).not.toHaveBeenCalled();
  });
});
