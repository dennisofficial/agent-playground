import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { EnvService } from '@core/config/env/env.service';
import type { LocalGitService } from '../git';
import { readForbiddenPaths } from '../git';
import type { WorktreeConfigStore, WorktreeSecretStore } from '../onboarding';
import type { MountSpec } from '../sandbox/container-paths';
import { WorktreeHydrator } from './worktree-hydrator.service';

const ORG = 'org-1';
const REPO = 'repo-uuid-1';
const SLUG = 'proj';

/** A git fake whose `isIgnored` consults a set of gitignored worktree-relative paths. */
function fakeGit(ignored: Set<string>): LocalGitService {
  return {
    isIgnored: async (_wt: string, p: string) => ignored.has(p),
  } as unknown as LocalGitService;
}

interface SecretWorld {
  values?: Record<string, string>;
  grants?: Array<{ name: string; path: string; repoId?: string }>;
  versions?: Record<string, number>;
}
function fakeSecrets(world: SecretWorld): WorktreeSecretStore {
  return {
    isGranted: async (orgId: string, repoId: string, name: string, path: string) =>
      orgId === ORG &&
      (world.grants ?? []).some(
        (g) => g.name === name && g.path === path && (g.repoId ?? REPO) === repoId,
      ),
    read: async (orgId: string, name: string) =>
      orgId === ORG ? (world.values?.[name] ?? null) : null,
    secretVersions: async () => world.versions ?? {},
    listGrants: async (_orgId: string, repoId: string) =>
      (world.grants ?? [])
        .filter((g) => (g.repoId ?? REPO) === repoId)
        .map((g) => ({ repoId: g.repoId ?? REPO, name: g.name, path: g.path })),
  } as unknown as WorktreeSecretStore;
}

interface ConfigWorld {
  mounts?: MountSpec[];
  seed?: string[];
}
/** The org+repo-scoped mounts/seed config, DB-backed in prod — faked in-memory here. */
function fakeConfig(world: ConfigWorld): WorktreeConfigStore {
  return {
    listMounts: async () => world.mounts ?? [],
    listSeed: async () => world.seed ?? [],
  } as unknown as WorktreeConfigStore;
}

function fakeEnv(golden?: string): EnvService {
  return { get: (k: string) => (k === 'ATLAS_GOLDEN_ROOT' ? golden : undefined) } as unknown as EnvService;
}

/** A config store that always rejects — simulates a Postgres hiccup on the worktree-config read path. */
function failingConfig(message = 'connect ECONNREFUSED'): WorktreeConfigStore {
  return {
    listMounts: async () => {
      throw new Error(message);
    },
    listSeed: async () => {
      throw new Error(message);
    },
  } as unknown as WorktreeConfigStore;
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

  it('renders a GRANTED, gitignored secret (NO config needed) atomically at 0600 + sidecar', async () => {
    // Grant-driven: no mounts/seed config entry — the owner grant alone drives rendering.
    const h = new WorktreeHydrator(
      fakeGit(new Set(['.env.keys'])),
      fakeSecrets({
        values: { dotenvxPrivateKeys: 'SECRET=1' },
        grants: [{ name: 'dotenvxPrivateKeys', path: '.env.keys' }],
      }),
      fakeConfig({}),
      fakeEnv(),
    );

    const { forbiddenPaths: forbidden } = await h.hydrateFiles({ worktreePath: wt, slug: SLUG, orgId: ORG, repoDbId: REPO });

    expect(forbidden).toEqual(['.env.keys']);
    expect(readFileSync(join(wt, '.env.keys'), 'utf8')).toBe('SECRET=1');
    expect(statSync(join(wt, '.env.keys')).mode & 0o777).toBe(0o600);
    // The sidecar (outside the worktree) lists the forbidden path for commitAll's leak-scan.
    expect(readForbiddenPaths(wt)).toEqual(['.env.keys']);
  });

  it('renders NOTHING when there are no grants (config carries no secrets, so nothing to fall back on)', async () => {
    const h = new WorktreeHydrator(
      fakeGit(new Set(['.env.keys'])),
      fakeSecrets({ values: { dotenvxPrivateKeys: 'SECRET=1' }, grants: [] }),
      fakeConfig({}),
      fakeEnv(),
    );
    const { forbiddenPaths: forbidden } = await h.hydrateFiles({ worktreePath: wt, slug: SLUG, orgId: ORG, repoDbId: REPO });
    expect(forbidden).toEqual([]);
    expect(existsSync(join(wt, '.env.keys'))).toBe(false);
  });

  it('renders granted secrets for EVERY thread (no more secret-free onboarding)', async () => {
    // skipSecrets is gone: onboarding threads now hydrate real secrets too (see the invariant comment
    // in worktree-hydrator.service.ts — intentional, so onboarding can actually boot the app).
    const h = new WorktreeHydrator(
      fakeGit(new Set(['.env.keys'])),
      fakeSecrets({ values: { s: 'v' }, grants: [{ name: 's', path: '.env.keys' }] }),
      fakeConfig({}),
      fakeEnv(),
    );
    const { forbiddenPaths: forbidden } = await h.hydrateFiles({
      worktreePath: wt, slug: SLUG, orgId: ORG, repoDbId: REPO,
    });
    expect(forbidden).toEqual(['.env.keys']);
    expect(existsSync(join(wt, '.env.keys'))).toBe(true);
  });

  it('refuses a granted secret whose target is NOT gitignored (PR-leak guard)', async () => {
    const h = new WorktreeHydrator(
      fakeGit(new Set()), // nothing ignored
      fakeSecrets({ values: { s: 'v' }, grants: [{ name: 's', path: 'config.json' }] }),
      fakeConfig({}),
      fakeEnv(),
    );
    const { forbiddenPaths: forbidden } = await h.hydrateFiles({ worktreePath: wt, slug: SLUG, orgId: ORG, repoDbId: REPO });
    expect(forbidden).toEqual([]);
    expect(existsSync(join(wt, 'config.json'))).toBe(false);
  });

  it('yields no secrets when repoDbId is absent (gate/legacy path)', async () => {
    const h = new WorktreeHydrator(
      fakeGit(new Set(['.env.keys'])),
      fakeSecrets({ values: { s: 'v' }, grants: [{ name: 's', path: '.env.keys' }] }),
      fakeConfig({}),
      fakeEnv(),
    );
    const { forbiddenPaths: forbidden } = await h.hydrateFiles({ worktreePath: wt, slug: SLUG, orgId: ORG });
    expect(forbidden).toEqual([]);
  });

  it('copies a golden seed file when missing, and does not clobber an existing one', async () => {
    const golden = mkdtempSync(join(tmpdir(), 'atlas-golden-'));
    mkdirSync(join(golden, ORG, SLUG), { recursive: true });
    writeFileSync(join(golden, ORG, SLUG, '.env.local'), 'FROM_GOLDEN');
    const h = new WorktreeHydrator(
      fakeGit(new Set(['.env.local'])),
      fakeSecrets({}),
      fakeConfig({ seed: ['.env.local'] }),
      fakeEnv(golden),
    );

    const { forbiddenPaths: first } = await h.hydrateFiles({ worktreePath: wt, slug: SLUG, orgId: ORG, repoDbId: REPO });
    expect(first).toEqual(['.env.local']);
    expect(readFileSync(join(wt, '.env.local'), 'utf8')).toBe('FROM_GOLDEN');

    // Agent edits it; a re-hydrate must NOT clobber.
    writeFileSync(join(wt, '.env.local'), 'EDITED');
    await h.hydrateFiles({ worktreePath: wt, slug: SLUG, orgId: ORG, repoDbId: REPO });
    expect(readFileSync(join(wt, '.env.local'), 'utf8')).toBe('EDITED');

    rmSync(golden, { recursive: true, force: true });
  });

  it('resolveMounts returns valid specs and drops traversal', async () => {
    const h = new WorktreeHydrator(
      fakeGit(new Set()),
      fakeSecrets({}),
      fakeConfig({
        mounts: [
          { path: '.cocoindex', mode: 'per-thread' },
          { path: '../evil', mode: 'per-thread' },
        ],
      }),
      fakeEnv(),
    );
    expect(await h.resolveMounts(ORG, REPO, wt)).toEqual([{ path: '.cocoindex', mode: 'per-thread' }]);
  });

  it('computeSig changes when a GRANTED secret version changes (rotation re-triggers hydration)', async () => {
    const h1 = new WorktreeHydrator(
      fakeGit(new Set()),
      fakeSecrets({ grants: [{ name: 'k', path: '.env.keys' }], versions: { k: 1 } }),
      fakeConfig({}),
      fakeEnv(),
    );
    const h2 = new WorktreeHydrator(
      fakeGit(new Set()),
      fakeSecrets({ grants: [{ name: 'k', path: '.env.keys' }], versions: { k: 2 } }),
      fakeConfig({}),
      fakeEnv(),
    );
    const a = await h1.computeSig(wt, ORG, REPO);
    const b = await h2.computeSig(wt, ORG, REPO);
    expect(a).not.toBe(b);
  });

  it('computeSig changes when a grant is added (so granting re-triggers hydration)', async () => {
    const ungranted = new WorktreeHydrator(
      fakeGit(new Set()),
      fakeSecrets({ grants: [] }),
      fakeConfig({}),
      fakeEnv(),
    );
    const granted = new WorktreeHydrator(
      fakeGit(new Set()),
      fakeSecrets({ grants: [{ name: 'k', path: '.env.keys' }] }),
      fakeConfig({}),
      fakeEnv(),
    );
    const a = await ungranted.computeSig(wt, ORG, REPO);
    const b = await granted.computeSig(wt, ORG, REPO);
    expect(a).not.toBe(b);
  });

  it('computeSig changes when a mount is added (so write_worktree_config re-triggers hydration)', async () => {
    const before = new WorktreeHydrator(fakeGit(new Set()), fakeSecrets({}), fakeConfig({}), fakeEnv());
    const after = new WorktreeHydrator(
      fakeGit(new Set()),
      fakeSecrets({}),
      fakeConfig({ mounts: [{ path: '.cocoindex', mode: 'per-thread' }] }),
      fakeEnv(),
    );
    const a = await before.computeSig(wt, ORG, REPO);
    const b = await after.computeSig(wt, ORG, REPO);
    expect(a).not.toBe(b);
  });

  it('computeSig changes when a seed path is added', async () => {
    const before = new WorktreeHydrator(fakeGit(new Set()), fakeSecrets({}), fakeConfig({}), fakeEnv());
    const after = new WorktreeHydrator(
      fakeGit(new Set()),
      fakeSecrets({}),
      fakeConfig({ seed: ['.env.local'] }),
      fakeEnv(),
    );
    const a = await before.computeSig(wt, ORG, REPO);
    const b = await after.computeSig(wt, ORG, REPO);
    expect(a).not.toBe(b);
  });

  describe('resilience — a worktree-config store failure never throws', () => {
    it('resolveMounts returns [] (not a rejection) when the store is down', async () => {
      const h = new WorktreeHydrator(fakeGit(new Set()), fakeSecrets({}), failingConfig(), fakeEnv());
      await expect(h.resolveMounts(ORG, REPO, wt)).resolves.toEqual([]);
    });

    it('computeSig still resolves (treating mounts/seed as empty) when the store is down', async () => {
      const h = new WorktreeHydrator(fakeGit(new Set()), fakeSecrets({}), failingConfig(), fakeEnv());
      await expect(h.computeSig(wt, ORG, REPO)).resolves.toEqual(expect.any(String));
    });

    it('hydrateFiles resolves with a notice (not a rejection) when the store is down, and secrets still render', async () => {
      const h = new WorktreeHydrator(
        fakeGit(new Set(['.env.keys'])),
        fakeSecrets({ values: { s: 'v' }, grants: [{ name: 's', path: '.env.keys' }] }),
        failingConfig('connect ECONNREFUSED'),
        fakeEnv(),
      );
      const { forbiddenPaths, notices } = await h.hydrateFiles({
        worktreePath: wt, slug: SLUG, orgId: ORG, repoDbId: REPO,
      });
      // Secrets are independent of worktree config — a config-store outage doesn't block secret rendering.
      expect(forbiddenPaths).toEqual(['.env.keys']);
      expect(notices.some((n) => n.includes('ECONNREFUSED'))).toBe(true);
    });
  });
});
