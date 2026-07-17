import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { LocalGitService } from '../../git/local-git.service';
import { readForbiddenPaths } from '../../git/hydration-sidecar';
import type { WorkspaceConfigStore } from '../../onboarding/workspace-config.store';
import type { WorkspaceSecretFileStore } from '../../onboarding/workspace-secret.store';
import type { MountSpec } from '../../sandbox/container-paths';
import { WorktreeHydrator } from '../worktree-hydrator.service';

const ORG = 'org-1';
const REPO = 'repo-uuid-1';

function fakeGit(ignored: Set<string>): LocalGitService {
  return {
    isIgnored: async (_wt: string, p: string) => ignored.has(p),
  } as unknown as LocalGitService;
}

interface SecretWorld {
  files?: Array<{
    path: string;
    value?: string;
    updatedAt?: number;
    label?: string | null;
    repoId?: string;
  }>;
}
function fakeSecrets(world: SecretWorld): WorkspaceSecretFileStore {
  const forRepo = (repoId: string) =>
    (world.files ?? []).filter((f) => (f.repoId ?? REPO) === repoId);
  return {
    read: async (orgId: string, repoId: string, path: string) =>
      orgId === ORG ? (forRepo(repoId).find((f) => f.path === path)?.value ?? null) : null,
    listForRepo: async (_orgId: string, repoId: string) =>
      forRepo(repoId).map((f) => ({
        path: f.path,
        label: f.label ?? null,
        updatedAt: f.updatedAt ?? 0,
      })),
    list: async (_orgId: string, repoId?: string) =>
      (repoId ? forRepo(repoId) : (world.files ?? [])).map((f) => ({
        repoId: f.repoId ?? REPO,
        path: f.path,
        label: f.label ?? null,
      })),
  } as unknown as WorkspaceSecretFileStore;
}

interface ConfigWorld {
  mounts?: MountSpec[];
}
function fakeConfig(world: ConfigWorld): WorkspaceConfigStore {
  return {
    listMounts: async () => world.mounts ?? [],
  } as unknown as WorkspaceConfigStore;
}

function failingConfig(message = 'connect ECONNREFUSED'): WorkspaceConfigStore {
  return {
    listMounts: async () => {
      throw new Error(message);
    },
  } as unknown as WorkspaceConfigStore;
}

describe('WorktreeHydrator', () => {
  let wt: string;
  let stateDir: string;
  const prevState = process.env.ATLAS_HYDRATION_STATE;

  beforeEach(() => {
    wt = mkdtempSync(join(tmpdir(), 'atlas-hyd-'));
    stateDir = mkdtempSync(join(tmpdir(), 'atlas-hyd-state-'));
    process.env.ATLAS_HYDRATION_STATE = stateDir;
  });
  afterEach(() => {
    rmSync(wt, { recursive: true, force: true });
    rmSync(stateDir, { recursive: true, force: true });
    if (prevState === undefined) delete process.env.ATLAS_HYDRATION_STATE;
    else process.env.ATLAS_HYDRATION_STATE = prevState;
  });

  it('renders a gitignored secret FILE (NO config needed) atomically at 0600 + sidecar', async () => {
    const h = new WorktreeHydrator(
      fakeGit(new Set(['.env.keys'])),
      fakeSecrets({ files: [{ path: '.env.keys', value: 'SECRET=1' }] }),
      fakeConfig({}),
    );

    const { forbiddenPaths: forbidden } = await h.hydrateFiles({
      worktreePath: wt,
      orgId: ORG,
      repoDbId: REPO,
    });

    expect(forbidden).toEqual(['.env.keys']);
    expect(readFileSync(join(wt, '.env.keys'), 'utf8')).toBe('SECRET=1');
    expect(statSync(join(wt, '.env.keys')).mode & 0o777).toBe(0o600);
    expect(readForbiddenPaths(wt)).toEqual(['.env.keys']);
  });

  it('renders NOTHING when there are no secret files (config carries no secrets, so nothing to fall back on)', async () => {
    const h = new WorktreeHydrator(
      fakeGit(new Set(['.env.keys'])),
      fakeSecrets({ files: [] }),
      fakeConfig({}),
    );
    const { forbiddenPaths: forbidden } = await h.hydrateFiles({
      worktreePath: wt,
      orgId: ORG,
      repoDbId: REPO,
    });
    expect(forbidden).toEqual([]);
    expect(existsSync(join(wt, '.env.keys'))).toBe(false);
  });

  it('renders secret files for EVERY thread (no more secret-free onboarding)', async () => {
    const h = new WorktreeHydrator(
      fakeGit(new Set(['.env.keys'])),
      fakeSecrets({ files: [{ path: '.env.keys', value: 'v' }] }),
      fakeConfig({}),
    );
    const { forbiddenPaths: forbidden } = await h.hydrateFiles({
      worktreePath: wt,
      orgId: ORG,
      repoDbId: REPO,
    });
    expect(forbidden).toEqual(['.env.keys']);
    expect(existsSync(join(wt, '.env.keys'))).toBe(true);
  });

  it('refuses a secret file whose target is NOT gitignored (PR-leak guard)', async () => {
    const h = new WorktreeHydrator(
      fakeGit(new Set()), // nothing ignored
      fakeSecrets({ files: [{ path: 'config.json', value: 'v' }] }),
      fakeConfig({}),
    );
    const { forbiddenPaths: forbidden } = await h.hydrateFiles({
      worktreePath: wt,
      orgId: ORG,
      repoDbId: REPO,
    });
    expect(forbidden).toEqual([]);
    expect(existsSync(join(wt, 'config.json'))).toBe(false);
  });

  it('skips a file that vanished before it could be read (concurrent delete) with a notice', async () => {
    const h = new WorktreeHydrator(
      fakeGit(new Set(['.env.keys'])),
      fakeSecrets({ files: [{ path: '.env.keys' }] }),
      fakeConfig({}),
    );
    const { forbiddenPaths, notices } = await h.hydrateFiles({
      worktreePath: wt,
      orgId: ORG,
      repoDbId: REPO,
    });
    expect(forbiddenPaths).toEqual([]);
    expect(existsSync(join(wt, '.env.keys'))).toBe(false);
    expect(notices.some((n) => n.includes('disappeared'))).toBe(true);
  });

  it('yields no secrets when repoDbId is absent (gate/legacy path)', async () => {
    const h = new WorktreeHydrator(
      fakeGit(new Set(['.env.keys'])),
      fakeSecrets({ files: [{ path: '.env.keys', value: 'v' }] }),
      fakeConfig({}),
    );
    const { forbiddenPaths: forbidden } = await h.hydrateFiles({
      worktreePath: wt,
      orgId: ORG,
    });
    expect(forbidden).toEqual([]);
  });

  it('resolveMounts returns valid specs and drops traversal', async () => {
    const h = new WorktreeHydrator(
      fakeGit(new Set()),
      fakeSecrets({}),
      fakeConfig({
        mounts: [
          { path: '.venv', mode: 'per-thread' },
          { path: '../evil', mode: 'per-thread' },
        ],
      }),
    );
    expect(await h.resolveMounts(ORG, REPO, wt)).toEqual([{ path: '.venv', mode: 'per-thread' }]);
  });

  it('resolveMounts keeps a valid EXTERNAL (absolute) mount and drops a reserved one', async () => {
    const h = new WorktreeHydrator(
      fakeGit(new Set()),
      fakeSecrets({}),
      fakeConfig({
        mounts: [
          { path: '/root/.config/gcloud', mode: 'shared-rw' }, // external, allowed
          { path: '/.atlas', mode: 'shared-rw' }, // external, reserved system bind → dropped
          { path: '.cache', mode: 'per-thread' }, // worktree-relative, allowed
        ],
      }),
    );
    expect(await h.resolveMounts(ORG, REPO, wt)).toEqual([
      { path: '/root/.config/gcloud', mode: 'shared-rw' },
      { path: '.cache', mode: 'per-thread' },
    ]);
  });

  it('computeSig changes when a secret file version changes (rotation re-triggers hydration)', async () => {
    const h1 = new WorktreeHydrator(
      fakeGit(new Set()),
      fakeSecrets({ files: [{ path: '.env.keys', updatedAt: 1 }] }),
      fakeConfig({}),
    );
    const h2 = new WorktreeHydrator(
      fakeGit(new Set()),
      fakeSecrets({ files: [{ path: '.env.keys', updatedAt: 2 }] }),
      fakeConfig({}),
    );
    const a = await h1.computeSig(wt, ORG, REPO);
    const b = await h2.computeSig(wt, ORG, REPO);
    expect(a).not.toBe(b);
  });

  it('computeSig changes when a secret file is added (so adding one re-triggers hydration)', async () => {
    const before = new WorktreeHydrator(
      fakeGit(new Set()),
      fakeSecrets({ files: [] }),
      fakeConfig({}),
    );
    const after = new WorktreeHydrator(
      fakeGit(new Set()),
      fakeSecrets({ files: [{ path: '.env.keys', updatedAt: 1 }] }),
      fakeConfig({}),
    );
    const a = await before.computeSig(wt, ORG, REPO);
    const b = await after.computeSig(wt, ORG, REPO);
    expect(a).not.toBe(b);
  });

  it('computeSig changes when a mount is added (so write_workspace_config re-triggers hydration)', async () => {
    const before = new WorktreeHydrator(fakeGit(new Set()), fakeSecrets({}), fakeConfig({}));
    const after = new WorktreeHydrator(
      fakeGit(new Set()),
      fakeSecrets({}),
      fakeConfig({ mounts: [{ path: '.venv', mode: 'per-thread' }] }),
    );
    const a = await before.computeSig(wt, ORG, REPO);
    const b = await after.computeSig(wt, ORG, REPO);
    expect(a).not.toBe(b);
  });

  describe('resilience — a worktree-config store failure never throws', () => {
    it('resolveMounts returns [] (not a rejection) when the store is down', async () => {
      const h = new WorktreeHydrator(fakeGit(new Set()), fakeSecrets({}), failingConfig());
      await expect(h.resolveMounts(ORG, REPO, wt)).resolves.toEqual([]);
    });

    it('computeSig still resolves (treating mounts as empty) when the store is down', async () => {
      const h = new WorktreeHydrator(fakeGit(new Set()), fakeSecrets({}), failingConfig());
      await expect(h.computeSig(wt, ORG, REPO)).resolves.toEqual(expect.any(String));
    });

    it('hydrateFiles resolves with a notice (not a rejection) when the store is down, and secrets still render', async () => {
      const h = new WorktreeHydrator(
        fakeGit(new Set(['.env.keys'])),
        fakeSecrets({ files: [{ path: '.env.keys', value: 'v' }] }),
        failingConfig('connect ECONNREFUSED'),
      );
      const { forbiddenPaths, notices } = await h.hydrateFiles({
        worktreePath: wt,
        orgId: ORG,
        repoDbId: REPO,
      });
      expect(forbiddenPaths).toEqual(['.env.keys']);
      expect(notices.some((n) => n.includes('ECONNREFUSED'))).toBe(true);
    });
  });
});
