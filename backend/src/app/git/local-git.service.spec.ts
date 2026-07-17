import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LocalGitService, type ProjectRepo } from './local-git.service';

/** A stub EnvService returning the temp repos root. */
function envStub(reposRoot: string) {
  return {
    get: (key: string) => (key === 'REPOS_ROOT' ? reposRoot : undefined),
  } as never;
}

/** Commit the worktree via raw git (the HOST no longer has a commit primitive — Atlas owns commits — so
 *  tests that need branch history make it directly). Returns the new HEAD sha. */
function commit(worktree: string, msg: string): string {
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: 'T',
    GIT_AUTHOR_EMAIL: 't@t',
    GIT_COMMITTER_NAME: 'T',
    GIT_COMMITTER_EMAIL: 't@t',
  };
  execFileSync('git', ['-C', worktree, 'add', '-A']);
  execFileSync('git', ['-C', worktree, 'commit', '-m', msg], { env });
  return execFileSync('git', ['-C', worktree, 'rev-parse', 'HEAD'], {
    encoding: 'utf8',
  }).trim();
}

/** Make a bare "origin" repo with one commit on `main` — the clone source for the tests. */
function makeOriginRepo(dir: string): string {
  const work = join(dir, 'origin-work');
  const bare = join(dir, 'origin.git');
  execFileSync('git', ['init', '-b', 'main', work]);
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: 'T',
    GIT_AUTHOR_EMAIL: 't@t',
    GIT_COMMITTER_NAME: 'T',
    GIT_COMMITTER_EMAIL: 't@t',
  };
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
    return svc.ensureRepo({
      repoId: 'acme-app',
      gitUrl: originUrl,
      defaultBranch: 'main',
    });
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
    const head = execFileSync(
      'git',
      ['-C', sandbox.worktreePath, 'rev-parse', '--abbrev-ref', 'HEAD'],
      {
        encoding: 'utf8',
      },
    ).trim();
    expect(head).toBe('atlas/feature-x');
  });

  it('reads the current branch, and null on a detached HEAD', async () => {
    const r = await repo();
    const sandbox = await svc.createFeatureSandbox(r, 'atlas/feature-x');
    expect(await svc.currentBranch(sandbox.worktreePath)).toBe('atlas/feature-x');
    // A rename (what the in-sandbox agent might do) is observed as the new branch.
    execFileSync('git', ['-C', sandbox.worktreePath, 'checkout', '-b', 'feat/renamed'], {
      encoding: 'utf8',
    });
    expect(await svc.currentBranch(sandbox.worktreePath)).toBe('feat/renamed');
    // Detached HEAD → `git branch --show-current` prints empty → null (don't clobber last-known).
    execFileSync('git', ['-C', sandbox.worktreePath, 'checkout', '--detach', 'HEAD'], {
      encoding: 'utf8',
    });
    expect(await svc.currentBranch(sandbox.worktreePath)).toBeNull();
  });

  it('reuses an existing worktree (idempotent)', async () => {
    const r = await repo();
    const a = await svc.createFeatureSandbox(r, 'atlas/feature-x');
    const b = await svc.createFeatureSandbox(r, 'atlas/feature-x');
    expect(b.worktreePath).toBe(a.worktreePath);
  });

  it('detects a dirty worktree; clean after a commit', async () => {
    const r = await repo();
    const sandbox = await svc.createFeatureSandbox(r, 'atlas/feature-x');
    expect(await svc.hasChanges(sandbox.worktreePath)).toBe(false);
    writeFileSync(join(sandbox.worktreePath, 'GATE.md'), 'gate\n');
    expect(await svc.hasChanges(sandbox.worktreePath)).toBe(true);
    commit(sandbox.worktreePath, 'feat: gate');
    expect(await svc.hasChanges(sandbox.worktreePath)).toBe(false);
  });

  it('pushes the feature branch to origin', async () => {
    const r = await repo();
    const sandbox = await svc.createFeatureSandbox(r, 'atlas/feature-x');
    writeFileSync(join(sandbox.worktreePath, 'GATE.md'), 'gate\n');
    commit(sandbox.worktreePath, 'feat: gate');
    await svc.push(sandbox);
    // The bare origin now has the feature branch.
    const branches = execFileSync('git', ['-C', originUrl, 'branch', '--list', 'atlas/feature-x'], {
      encoding: 'utf8',
    }).trim();
    expect(branches).toContain('atlas/feature-x');
  });

  it('reposRoot prefers REPOS_ROOT', () => {
    expect(svc.reposRoot()).toContain('repos');
  });

  // ── worktreeSafeToRecut — the hard-reset guard: is it safe to delete + re-cut this worktree without
  // losing committed work? Linked worktree = always (shared common dir); full clone = only if pushed. ───
  describe('worktreeSafeToRecut', () => {
    it('a LINKED worktree is always safe — its objects survive in the shared common dir', async () => {
      const r = await repo();
      const sandbox = await svc.createFeatureSandbox(r, 'atlas/feature-x');
      writeFileSync(join(sandbox.worktreePath, 'F.md'), 'x\n');
      commit(sandbox.worktreePath, 'unpushed local commit'); // never pushed — still safe for a linked worktree
      expect(await svc.worktreeSafeToRecut(sandbox.worktreePath, 'atlas/feature-x')).toBe(true);
    });

    it('a FULL CLONE with unpushed commits is UNSAFE (rm -rf would lose them)', async () => {
      const r = await repo();
      const base = await svc.createBaseClone(r, 'job-unsafe'); // full clone (`.git` is a dir)
      const sb = await svc.switchBranch(base, r, 'atlas/feat-y');
      writeFileSync(join(sb.worktreePath, 'F.md'), 'x\n');
      commit(sb.worktreePath, 'unpushed'); // origin/atlas/feat-y does not exist → unsafe
      expect(await svc.worktreeSafeToRecut(sb.worktreePath, 'atlas/feat-y')).toBe(false);
    });

    it('a FULL CLONE whose branch is fully pushed is safe', async () => {
      const r = await repo();
      const base = await svc.createBaseClone(r, 'job-safe');
      const sb = await svc.switchBranch(base, r, 'atlas/feat-z');
      await svc.push(sb); // origin/atlas/feat-z now exists at HEAD — nothing ahead
      expect(await svc.worktreeSafeToRecut(sb.worktreePath, 'atlas/feat-z')).toBe(true);
    });
  });

  // Regression: a stray/concurrent external git process (e.g. the sandbox's own engine turn) can hold the
  // worktree's OS-level index.lock. The in-process mutex can't see it — `git()` must retry past it instead
  // of failing the whole build (this is the "index.lock: File exists" error surfaced to the operator).
  it('retries past a transient index.lock held by another process', async () => {
    const r = await repo();
    const sandbox = await svc.createFeatureSandbox(r, 'atlas/feature-x');

    const lockPath = execFileSync(
      'git',
      ['-C', sandbox.worktreePath, 'rev-parse', '--git-path', 'index.lock'],
      { encoding: 'utf8' },
    ).trim();
    writeFileSync(lockPath, ''); // simulate another process mid-write
    setTimeout(() => rmSync(lockPath, { force: true }), 400); // released before retries exhaust

    // `switchBranch` runs `git checkout -b …` through `svc.git()`, which takes the index.lock and must retry
    // past the held lock instead of failing (the "index.lock: File exists" resilience the retry exists for).
    const switched = await svc.switchBranch(sandbox, r, 'atlas/feature-y');
    expect(switched.branch).toBe('atlas/feature-y');
  });

  // ── changedFileNames (ADR 0005 §2c) — the per-thread diff signal `complete_thread` reads BEFORE commit:
  // tracked changes since a base sha (two-dot, not `...HEAD`) PLUS untracked files. ─────────────────────
  describe('changedFileNames', () => {
    it('reports tracked changes since a base sha', async () => {
      const r = await repo();
      const sandbox = await svc.createFeatureSandbox(r, 'atlas/feature-x');
      const base = await svc.headSha(sandbox.worktreePath);
      writeFileSync(join(sandbox.worktreePath, 'README.md'), '# origin\nedited\n');
      commit(sandbox.worktreePath, 'edit readme');

      expect(await svc.changedFileNames(sandbox.worktreePath, base)).toEqual(['README.md']);
    });

    it('includes an UNTRACKED new file — the case a plain `git diff` would silently miss', async () => {
      const r = await repo();
      const sandbox = await svc.createFeatureSandbox(r, 'atlas/feature-x');
      const base = await svc.headSha(sandbox.worktreePath);
      // Never staged, never committed — exactly the shape `complete_thread` sees mid-turn, before commit.
      writeFileSync(join(sandbox.worktreePath, 'NEW_ROUTE.ts'), 'export const x = 1;\n');

      expect(await svc.changedFileNames(sandbox.worktreePath, base)).toEqual(['NEW_ROUTE.ts']);
    });

    it('no changes → empty list', async () => {
      const r = await repo();
      const sandbox = await svc.createFeatureSandbox(r, 'atlas/feature-x');
      const base = await svc.headSha(sandbox.worktreePath);

      expect(await svc.changedFileNames(sandbox.worktreePath, base)).toEqual([]);
    });

    it('an invalid base sha is caught, never thrown — empty list', async () => {
      const r = await repo();
      const sandbox = await svc.createFeatureSandbox(r, 'atlas/feature-x');

      expect(await svc.changedFileNames(sandbox.worktreePath, 'not-a-real-sha')).toEqual([]);
    });
  });
});
