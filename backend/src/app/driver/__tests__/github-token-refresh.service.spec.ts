/**
 * Unit tests for `GithubTokenRefreshService.tick` — the leader-gated sweep that keeps every ACTIVE
 * app-mode sandbox's in-sandbox GitHub token file current. No DB, no Docker — the TypeORM repository and
 * the credential resolver / sandbox provider are fake stubs.
 */

import type { Repository } from 'typeorm';
import { describe, expect, it, vi } from 'vitest';
import type { CredentialResolver } from '../../onboarding';
import type { JobSandboxEntity } from '../../persistence/entities';
import type { SandboxProvider } from '../../sandbox/sandbox-provider.port';
import { GithubTokenRefreshService } from '../github-token-refresh.service';

/** Build a bare-minimum JobSandboxEntity row for the sweep's enumeration. */
function makeRow(overrides: Partial<JobSandboxEntity> = {}): JobSandboxEntity {
  return {
    id: 'sandbox-1',
    org_id: 'org-1',
    job_id: 'job-1',
    repo_id: 'repo-uuid-1',
    worktree_path: '/repos/proj/.worktrees/job-1',
    container_id: 'container-1',
    lifecycle: 'attached',
    session_id: null,
    last_active_at: null,
    created_at: new Date(),
    updated_at: new Date(),
    ...overrides,
  } as JobSandboxEntity;
}

function makeService(rows: JobSandboxEntity[]) {
  const sandboxes = {
    find: vi.fn().mockResolvedValue(rows),
  } as unknown as Repository<JobSandboxEntity>;
  const creds = {
    githubAuthMode: vi.fn(),
    githubToken: vi.fn(),
  } as unknown as CredentialResolver;
  const sandbox = {
    writeGithubTokenFile: vi.fn().mockResolvedValue(undefined),
  } as unknown as SandboxProvider;
  const service = new GithubTokenRefreshService(sandboxes, creds, sandbox);
  return { service, sandboxes, creds, sandbox };
}

describe('GithubTokenRefreshService.tick', () => {
  it('writes the resolved token for an app-mode active sandbox', async () => {
    const row = makeRow({ org_id: 'org-app', job_id: 'job-app' });
    const { service, creds, sandbox } = makeService([row]);
    (creds.githubAuthMode as ReturnType<typeof vi.fn>).mockResolvedValue('app');
    (creds.githubToken as ReturnType<typeof vi.fn>).mockResolvedValue('ghs_fresh-token');

    await service.tick();

    expect(sandbox.writeGithubTokenFile).toHaveBeenCalledWith('job-app', 'ghs_fresh-token');
  });

  it('skips a pat-mode active sandbox — no file to refresh', async () => {
    const row = makeRow({ org_id: 'org-pat', job_id: 'job-pat' });
    const { service, creds, sandbox } = makeService([row]);
    (creds.githubAuthMode as ReturnType<typeof vi.fn>).mockResolvedValue('pat');

    await service.tick();

    expect(creds.githubToken).not.toHaveBeenCalled();
    expect(sandbox.writeGithubTokenFile).not.toHaveBeenCalled();
  });

  it('skips an inactive sandbox (no container_id) even if app-mode', async () => {
    const row = makeRow({
      org_id: 'org-app',
      job_id: 'job-inactive',
      container_id: null,
    });
    const { service, creds, sandbox } = makeService([row]);
    (creds.githubAuthMode as ReturnType<typeof vi.fn>).mockResolvedValue('app');
    (creds.githubToken as ReturnType<typeof vi.fn>).mockResolvedValue('ghs_fresh-token');

    await service.tick();

    expect(creds.githubAuthMode).not.toHaveBeenCalled();
    expect(sandbox.writeGithubTokenFile).not.toHaveBeenCalled();
  });

  it('a failure writing one sandbox does not stop the sweep from reaching the next', async () => {
    const failing = makeRow({ org_id: 'org-app', job_id: 'job-fail' });
    const ok = makeRow({ org_id: 'org-app', job_id: 'job-ok' });
    const { service, creds, sandbox } = makeService([failing, ok]);
    (creds.githubAuthMode as ReturnType<typeof vi.fn>).mockResolvedValue('app');
    (creds.githubToken as ReturnType<typeof vi.fn>).mockResolvedValue('ghs_fresh-token');
    (sandbox.writeGithubTokenFile as ReturnType<typeof vi.fn>)
      .mockRejectedValueOnce(new Error('transient mint error'))
      .mockResolvedValueOnce(undefined);

    await expect(service.tick()).resolves.toBeUndefined();

    expect(sandbox.writeGithubTokenFile).toHaveBeenCalledTimes(2);
    expect(sandbox.writeGithubTokenFile).toHaveBeenNthCalledWith(1, 'job-fail', 'ghs_fresh-token');
    expect(sandbox.writeGithubTokenFile).toHaveBeenNthCalledWith(2, 'job-ok', 'ghs_fresh-token');
  });
});
