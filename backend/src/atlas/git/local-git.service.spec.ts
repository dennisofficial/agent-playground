import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LocalGitService, type ProjectRepo } from './local-git.service';

/** A stub EnvService returning the temp repos root. */
function envStub(reposRoot: string) {
  return {
    get: (key: string) => (key === 'ATLAS_REPOS_ROOT' ? reposRoot : undefined),
  } as never;
}

/** Make a bare "origin" repo with one commit on `main` — the clone source for the tests. */
function makeOriginRepo(dir: string): string {
  const work = join(dir, 'origin-work');
  const bare = join(dir, 'origin.git');
  execFileSync('git', ['init', '-b', 'main', work]);
  const env = { ...process.env, GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@t' };
  writeFileSync(join(work, 'README.md'), '# origin\n');
  execFileSync('git', ['-C', work, 'add', '-A']);
  execFileSync('git', ['-C', work, 'commit', '-m', 'init'], { env });
  execFileSync('git', ['clone', '--bare', work, bare]);
  // Point origin/HEAD at main so detectDefaultBranch resolves it.
  execFileSync('git', ['-C', bare, 'symbolic-ref', 'HEAD', 'refs/heads/main']);
  return bare;
}

describe('LocalGitService (host git, daemon-free)', () => {
  let tmp: string;
  let svc: LocalGitService;
  let originUrl: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'atlas-git-'));
    const reposRoot = join(tmp, 'repos');
    svc = new LocalGitService(envStub(reposRoot));
    originUrl = makeOriginRepo(tmp); // a file:// path — gitAuthEnv applies no token to non-https
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  async function repo(): Promise<ProjectRepo> {
    return svc.ensureRepo({ projectId: 'acme-app', gitUrl: originUrl, defaultBranch: 'main' });
  }

  it('clones a repo on first use and reuses it on the second', async () => {
    const r1 = await repo();
    expect(existsSync(join(r1.repoPath, '.git'))).toBe(true);
    expect(r1.defaultBranch).toBe('main');
    // Second ensureRepo must not re-clone (same path).
    const r2 = await repo();
    expect(r2.repoPath).toBe(r1.repoPath);
  });

  it('cuts a per-feature worktree on a fresh branch off the base', async () => {
    const r = await repo();
    const sandbox = await svc.createFeatureSandbox(r, 'atlas/feature-x');
    expect(existsSync(sandbox.worktreePath)).toBe(true);
    expect(sandbox.branch).toBe('atlas/feature-x');
    // The checked-out branch is the feature branch.
    const head = execFileSync('git', ['-C', sandbox.worktreePath, 'rev-parse', '--abbrev-ref', 'HEAD'], {
      encoding: 'utf8',
    }).trim();
    expect(head).toBe('atlas/feature-x');
  });

  it('reuses an existing worktree (idempotent)', async () => {
    const r = await repo();
    const a = await svc.createFeatureSandbox(r, 'atlas/feature-x');
    const b = await svc.createFeatureSandbox(r, 'atlas/feature-x');
    expect(b.worktreePath).toBe(a.worktreePath);
  });

  it('commits staged changes and reports the new sha; no-op when clean', async () => {
    const r = await repo();
    const sandbox = await svc.createFeatureSandbox(r, 'atlas/feature-x');
    // Clean worktree → nothing to commit.
    expect(await svc.commitAll(sandbox.worktreePath, 'noop')).toBeNull();
    // Add a change → commit returns a sha.
    writeFileSync(join(sandbox.worktreePath, 'ATLAS_GATE.md'), 'gate\n');
    expect(await svc.hasChanges(sandbox.worktreePath)).toBe(true);
    const sha = await svc.commitAll(sandbox.worktreePath, 'feat: gate');
    expect(sha).toMatch(/^[0-9a-f]{40}$/);
    expect(await svc.hasChanges(sandbox.worktreePath)).toBe(false);
  });

  it('pushes the feature branch to origin', async () => {
    const r = await repo();
    const sandbox = await svc.createFeatureSandbox(r, 'atlas/feature-x');
    writeFileSync(join(sandbox.worktreePath, 'ATLAS_GATE.md'), 'gate\n');
    await svc.commitAll(sandbox.worktreePath, 'feat: gate');
    await svc.push(sandbox);
    // The bare origin now has the feature branch.
    const branches = execFileSync('git', ['-C', originUrl, 'branch', '--list', 'atlas/feature-x'], {
      encoding: 'utf8',
    }).trim();
    expect(branches).toContain('atlas/feature-x');
  });

  it('reposRoot prefers ATLAS_REPOS_ROOT', () => {
    expect(svc.reposRoot()).toContain('repos');
  });
});
