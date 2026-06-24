/**
 * Unit tests for `ThreadLifecycleService.rowToSandbox` (accessed via a cast to bypass `private`).
 *
 * Verifies the bug fix: `execUser` is recomputed from the host process uid:gid when the persisted
 * row has a `container_id` (docker mode), and is absent when there is no container (local mode).
 *
 * No DB, no Docker — all TypeORM repositories are mocked stubs.
 */

import type { EnvService } from '@core/config/env/env.service';
import { describe, expect, it, vi } from 'vitest';
import type { Repository } from 'typeorm';
import type { AtlasRepo, AtlasThread, AtlasThreadSandbox } from '../persistence/entities';
import type { GithubPrService, LocalGitService } from '../git';
import type { CredentialResolver, OnboardingService } from '../onboarding';
import type { DriverRepoResolver } from './repo-resolver';
import { SandboxActivityRegistry, type SandboxProvider } from '../sandbox';
import { ThreadLifecycleService } from './thread-lifecycle.service';

// ── helpers ─────────────────────────────────────────────────────────────────────────────────────

/** Build a bare-minimum AtlasThreadSandbox row for testing rowToSandbox. */
function makeRow(overrides: Partial<AtlasThreadSandbox> = {}): AtlasThreadSandbox {
  return {
    id: 'sandbox-1',
    org_id: 'T1',
    thread_id: 'thread-1',
    repo_id: 'proj',
    base_branch: 'main',
    feature_branch: null,
    worktree_path: '/repos/proj/.worktrees/thread-1',
    container_id: null,
    lifecycle: 'attached',
    session_id: null,
    last_active_at: null,
    pr_url: null,
    pr_number: null,
    created_at: new Date(),
    updated_at: new Date(),
    ...overrides,
  } as AtlasThreadSandbox;
}

/** Construct a ThreadLifecycleService with all deps stubbed to no-ops. */
function makeService(): ThreadLifecycleService {
  const stubRepo = () =>
    ({
      findOne: vi.fn(),
      save: vi.fn(),
      create: vi.fn(),
    }) as unknown as Repository<never>;

  return new ThreadLifecycleService(
    stubRepo() as unknown as Repository<AtlasThread>,
    stubRepo() as unknown as Repository<AtlasThreadSandbox>,
    stubRepo() as unknown as Repository<AtlasRepo>,
    { bindChannel: vi.fn() } as unknown as OnboardingService,
    {} as unknown as LocalGitService,
    { getPullState: vi.fn() } as unknown as GithubPrService,
    { githubToken: vi.fn() } as unknown as CredentialResolver,
    { get: vi.fn() } as unknown as EnvService,
    new SandboxActivityRegistry(),
    { resolve: vi.fn() } as unknown as DriverRepoResolver,
    { attach: vi.fn(), teardown: vi.fn() } as unknown as SandboxProvider,
  );
}

// Cast to access the private rowToSandbox method from tests.
function rowToSandbox(svc: ThreadLifecycleService, row: AtlasThreadSandbox) {
  return (svc as unknown as { rowToSandbox(r: AtlasThreadSandbox): import('../git').FeatureSandbox })
    .rowToSandbox(row);
}

// ── tests ────────────────────────────────────────────────────────────────────────────────────────

describe('ThreadLifecycleService.rowToSandbox', () => {
  it('populates execUser with the host uid:gid for a row WITH a container_id (docker mode)', () => {
    const svc = makeService();
    const row = makeRow({ container_id: 'abc123def456' });

    const sandbox = rowToSandbox(svc, row);

    // containerId must be propagated.
    expect(sandbox).toMatchObject({ containerId: 'abc123def456' });

    // execUser must be recomputed — on Linux/macOS process.getuid/getgid are available.
    const uid = typeof process.getuid === 'function' ? process.getuid() : undefined;
    const gid = typeof process.getgid === 'function' ? process.getgid() : undefined;

    if (uid !== undefined && gid !== undefined) {
      expect(sandbox.execUser).toBe(`${uid}:${gid}`);
    } else {
      // On platforms without uid/gid (e.g. Windows CI), the field must be absent — not set to "undefined:undefined".
      expect(sandbox.execUser).toBeUndefined();
    }
  });

  it('omits execUser for a row WITHOUT a container_id (local mode)', () => {
    const svc = makeService();
    const row = makeRow({ container_id: null });

    const sandbox = rowToSandbox(svc, row);

    expect(sandbox.containerId).toBeUndefined();
    expect(sandbox.execUser).toBeUndefined();
  });

  it('uses feature_branch when set, falls back to base_branch', () => {
    const svc = makeService();

    const branched = rowToSandbox(svc, makeRow({ container_id: 'x', feature_branch: 'atlas/feature-abc', base_branch: 'main' }));
    expect(branched.branch).toBe('atlas/feature-abc');

    const base = rowToSandbox(svc, makeRow({ container_id: 'x', feature_branch: null, base_branch: 'main' }));
    expect(base.branch).toBe('main');
  });
});
