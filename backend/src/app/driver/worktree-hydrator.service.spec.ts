import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { EnvService } from '@core/config/env/env.service';
import type { LocalGitService } from '../git';
import { readForbiddenPaths } from '../git';
import type { WorktreeSecretStore } from '../onboarding';
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

function fakeEnv(golden?: string): EnvService {
  return { get: (k: string) => (k === 'ATLAS_GOLDEN_ROOT' ? golden : undefined) } as unknown as EnvService;
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

  function writeManifest(obj: unknown): void {
    mkdirSync(join(wt, '.atlas'), { recursive: true });
    writeFileSync(join(wt, '.atlas', 'worktree.json'), JSON.stringify(obj));
  }

  it('renders a GRANTED, gitignored secret atomically at 0600 and records it in the sidecar', async () => {
    writeManifest({ secrets: [{ path: '.env.keys', from: 'dotenvxPrivateKeys' }] });
    const h = new WorktreeHydrator(
      fakeGit(new Set(['.env.keys'])),
      fakeSecrets({
        values: { dotenvxPrivateKeys: 'SECRET=1' },
        grants: [{ name: 'dotenvxPrivateKeys', path: '.env.keys' }],
      }),
      fakeEnv(),
    );

    const { forbiddenPaths: forbidden } = await h.hydrateFiles({ worktreePath: wt, slug: SLUG, orgId: ORG, repoDbId: REPO });

    expect(forbidden).toEqual(['.env.keys']);
    expect(readFileSync(join(wt, '.env.keys'), 'utf8')).toBe('SECRET=1');
    expect(statSync(join(wt, '.env.keys')).mode & 0o777).toBe(0o600);
    // The sidecar (outside the worktree) lists the forbidden path for commitAll's leak-scan.
    expect(readForbiddenPaths(wt)).toEqual(['.env.keys']);
  });

  it('does NOT render an UNGRANTED secret', async () => {
    writeManifest({ secrets: [{ path: '.env.keys', from: 'dotenvxPrivateKeys' }] });
    const h = new WorktreeHydrator(
      fakeGit(new Set(['.env.keys'])),
      fakeSecrets({ values: { dotenvxPrivateKeys: 'SECRET=1' }, grants: [] }),
      fakeEnv(),
    );
    const { forbiddenPaths: forbidden } = await h.hydrateFiles({ worktreePath: wt, slug: SLUG, orgId: ORG, repoDbId: REPO });
    expect(forbidden).toEqual([]);
    expect(existsSync(join(wt, '.env.keys'))).toBe(false);
  });

  it('refuses a granted secret whose target is NOT gitignored (PR-leak guard)', async () => {
    writeManifest({ secrets: [{ path: 'config.json', from: 's' }] });
    const h = new WorktreeHydrator(
      fakeGit(new Set()), // nothing ignored
      fakeSecrets({ values: { s: 'v' }, grants: [{ name: 's', path: 'config.json' }] }),
      fakeEnv(),
    );
    const { forbiddenPaths: forbidden } = await h.hydrateFiles({ worktreePath: wt, slug: SLUG, orgId: ORG, repoDbId: REPO });
    expect(forbidden).toEqual([]);
    expect(existsSync(join(wt, 'config.json'))).toBe(false);
  });

  it('yields no secrets when repoDbId is absent (gate/legacy path)', async () => {
    writeManifest({ secrets: [{ path: '.env.keys', from: 's' }] });
    const h = new WorktreeHydrator(
      fakeGit(new Set(['.env.keys'])),
      fakeSecrets({ values: { s: 'v' }, grants: [{ name: 's', path: '.env.keys' }] }),
      fakeEnv(),
    );
    const { forbiddenPaths: forbidden } = await h.hydrateFiles({ worktreePath: wt, slug: SLUG, orgId: ORG });
    expect(forbidden).toEqual([]);
  });

  it('copies a golden seed file when missing, and does not clobber an existing one', async () => {
    const golden = mkdtempSync(join(tmpdir(), 'atlas-golden-'));
    mkdirSync(join(golden, ORG, SLUG), { recursive: true });
    writeFileSync(join(golden, ORG, SLUG, '.env.local'), 'FROM_GOLDEN');
    writeManifest({ seed: ['.env.local'] });
    const h = new WorktreeHydrator(fakeGit(new Set(['.env.local'])), fakeSecrets({}), fakeEnv(golden));

    const { forbiddenPaths: first } = await h.hydrateFiles({ worktreePath: wt, slug: SLUG, orgId: ORG, repoDbId: REPO });
    expect(first).toEqual(['.env.local']);
    expect(readFileSync(join(wt, '.env.local'), 'utf8')).toBe('FROM_GOLDEN');

    // Agent edits it; a re-hydrate must NOT clobber.
    writeFileSync(join(wt, '.env.local'), 'EDITED');
    await h.hydrateFiles({ worktreePath: wt, slug: SLUG, orgId: ORG, repoDbId: REPO });
    expect(readFileSync(join(wt, '.env.local'), 'utf8')).toBe('EDITED');

    rmSync(golden, { recursive: true, force: true });
  });

  it('resolveMounts returns valid specs and drops traversal', () => {
    writeManifest({
      mounts: [
        { path: '.cocoindex', mode: 'per-thread' },
        { path: '../evil', mode: 'per-thread' },
      ],
    });
    const h = new WorktreeHydrator(fakeGit(new Set()), fakeSecrets({}), fakeEnv());
    expect(h.resolveMounts(wt)).toEqual([{ path: '.cocoindex', mode: 'per-thread' }]);
  });

  it('computeSig changes when a referenced secret version changes', async () => {
    writeManifest({ secrets: [{ path: '.env.keys', from: 'k' }] });
    const h1 = new WorktreeHydrator(fakeGit(new Set()), fakeSecrets({ versions: { k: 1 } }), fakeEnv());
    const h2 = new WorktreeHydrator(fakeGit(new Set()), fakeSecrets({ versions: { k: 2 } }), fakeEnv());
    const a = await h1.computeSig(wt, ORG);
    const b = await h2.computeSig(wt, ORG);
    expect(a).not.toBe(b);
  });

  it('computeSig changes when a grant is added (so granting re-triggers hydration)', async () => {
    writeManifest({ secrets: [{ path: '.env.keys', from: 'k' }] });
    const ungranted = new WorktreeHydrator(fakeGit(new Set()), fakeSecrets({ grants: [] }), fakeEnv());
    const granted = new WorktreeHydrator(
      fakeGit(new Set()),
      fakeSecrets({ grants: [{ name: 'k', path: '.env.keys' }] }),
      fakeEnv(),
    );
    const a = await ungranted.computeSig(wt, ORG, REPO);
    const b = await granted.computeSig(wt, ORG, REPO);
    expect(a).not.toBe(b);
  });

  it('returns an operator-facing notice for an ungranted secret', async () => {
    writeManifest({ secrets: [{ path: '.env.keys', from: 'dotenvxPrivateKeys' }] });
    const h = new WorktreeHydrator(
      fakeGit(new Set(['.env.keys'])),
      fakeSecrets({ values: { dotenvxPrivateKeys: 'v' }, grants: [] }),
      fakeEnv(),
    );
    const { notices } = await h.hydrateFiles({ worktreePath: wt, slug: SLUG, orgId: ORG, repoDbId: REPO });
    expect(notices.some((n) => /not granted/i.test(n))).toBe(true);
  });

  it('surfaces a malformed manifest as a notice (never throws)', async () => {
    mkdirSync(join(wt, '.atlas'), { recursive: true });
    writeFileSync(join(wt, '.atlas', 'worktree.json'), '{ not json');
    const h = new WorktreeHydrator(fakeGit(new Set()), fakeSecrets({}), fakeEnv());
    const { forbiddenPaths, notices } = await h.hydrateFiles({ worktreePath: wt, slug: SLUG, orgId: ORG, repoDbId: REPO });
    expect(forbiddenPaths).toEqual([]);
    expect(notices.some((n) => /unreadable/i.test(n))).toBe(true);
  });
});
