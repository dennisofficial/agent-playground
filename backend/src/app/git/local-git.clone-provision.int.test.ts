import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { EnvService } from '@core/config/env/env.service';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LocalGitService, type ProjectRepo } from './local-git.service';

const execFileAsync = promisify(execFile);

/**
 * Real-git verification of full-clone provisioning for submodule repos. A repo WITH submodules is
 * now provisioned as a full LOCAL CLONE (a real `.git` DIR at the worktree path, submodule gitdirs
 * under `<clone>/.git/modules/…`) instead of a linked worktree — the linked worktree's shared-common-dir
 * submodule gitdirs get an unresolvable relative `core.worktree` across the container's split mounts,
 * which fatals `git add -A` at ship. A repo WITHOUT submodules keeps the existing linked-worktree path
 * byte-for-byte.
 *
 * Local remotes use `file://`, which git blocks by default. Production deliberately leaves that
 * transport disabled (tenant-repo safety); the test opts in via the `GIT_ALLOW_PROTOCOL` env hatch —
 * the prod code never sets it.
 */
describe('LocalGitService — full-clone provisioning for submodule repos (real git)', () => {
  let root: string;
  let subRemote: string;
  let superRemote: string;
  let mainClone: string;
  let gitUrl: string;
  let repo: ProjectRepo;
  let git: LocalGitService;
  let prevAllowProtocol: string | undefined;

  const g = (args: string[], cwd: string) => execFileAsync('git', args, { cwd });

  /** A second, submodule-free fixture for the "unchanged" / linked-worktree assertions. */
  async function buildNoSubmoduleFixture(): Promise<{ repo: ProjectRepo; mainClone: string }> {
    const superRemote2 = join(root, 'super-remote-nosub');
    await execFileAsync('mkdir', ['-p', superRemote2]);
    await g(['init', '-q', '-b', 'main'], superRemote2);
    await g(['config', 'user.email', 'test@atlas.dev'], superRemote2);
    await g(['config', 'user.name', 'Test'], superRemote2);
    writeFileSync(join(superRemote2, 'README.md'), '# super-nosub');
    await g(['add', '-A'], superRemote2);
    await g(['commit', '-qm', 'super-nosub'], superRemote2);

    const gitUrl2 = `file://${superRemote2}`;
    const mainClone2 = join(root, 'mainclone-nosub');
    await g(['clone', '-q', gitUrl2, mainClone2], root);

    const repo2: ProjectRepo = {
      repoId: 'proj-nosub',
      gitUrl: gitUrl2,
      defaultBranch: 'main',
      repoPath: mainClone2,
    };
    return { repo: repo2, mainClone: mainClone2 };
  }

  beforeEach(async () => {
    // Opt into file:// transport for THIS process (prod never does).
    prevAllowProtocol = process.env.GIT_ALLOW_PROTOCOL;
    process.env.GIT_ALLOW_PROTOCOL = 'file:https:ssh';

    root = mkdtempSync(join(tmpdir(), 'atlas-clone-provision-'));
    git = new LocalGitService({ get: () => undefined } as unknown as EnvService);

    // 1. A submodule "remote".
    subRemote = join(root, 'sub-remote');
    await execFileAsync('mkdir', ['-p', subRemote]);
    await g(['init', '-q', '-b', 'main'], subRemote);
    await g(['config', 'user.email', 'test@atlas.dev'], subRemote);
    await g(['config', 'user.name', 'Test'], subRemote);
    writeFileSync(join(subRemote, 'package.json'), '{"name":"@workspace/shared"}');
    await g(['add', '-A'], subRemote);
    await g(['commit', '-qm', 'sub'], subRemote);

    // 2. A superproject "remote" that references the submodule via a RELATIVE url.
    superRemote = join(root, 'super-remote');
    await execFileAsync('mkdir', ['-p', superRemote]);
    await g(['init', '-q', '-b', 'main'], superRemote);
    await g(['config', 'user.email', 'test@atlas.dev'], superRemote);
    await g(['config', 'user.name', 'Test'], superRemote);
    writeFileSync(join(superRemote, 'README.md'), '# super');
    await g(['-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', '../sub-remote', 'packages/shared'], superRemote);
    await g(['add', '-A'], superRemote);
    await g(['commit', '-qm', 'super'], superRemote);

    // 3. The persistent MAIN CLONE — `createBaseWorktree`/`provisionFullClone` clone FROM this path,
    // and `repoHasSubmodules` reads its checked-out `.gitmodules`.
    gitUrl = `file://${superRemote}`;
    mainClone = join(root, 'mainclone');
    await g(['clone', '-q', gitUrl, mainClone], root);

    repo = {
      repoId: 'proj',
      gitUrl,
      defaultBranch: 'main',
      repoPath: mainClone,
    };
  });

  afterEach(() => {
    if (prevAllowProtocol === undefined) delete process.env.GIT_ALLOW_PROTOCOL;
    else process.env.GIT_ALLOW_PROTOCOL = prevAllowProtocol;
    rmSync(root, { recursive: true, force: true });
  });

  it('reproduces the pre-fix bug: a linked worktree + corrupted submodule core.worktree fatals `git add -A` (control)', async () => {
    const wt = join(mainClone, '.worktrees', 'bug-repro');
    await g(['fetch', 'origin', 'main'], mainClone);
    await g(['worktree', 'add', '-q', '--detach', wt, 'origin/main'], mainClone);
    await git.ensureSubmodules(wt, { gitUrl });

    // Corrupt the submodule's per-worktree gitdir core.worktree to an unresolvable relative shape —
    // this is the shape a linked worktree's shared-common-dir submodule gitdir takes across the
    // container's two mounts.
    const subConfigPath = join(mainClone, '.git', 'worktrees', 'bug-repro', 'modules', 'packages', 'shared', 'config');
    const config = readFileSync(subConfigPath, 'utf8');
    const broken = config.replace(
      /worktree = .*/,
      'worktree = ../../../../../../nonexistent-mount/bug-repro/packages/shared',
    );
    writeFileSync(subConfigPath, broken);

    // Dirty the submodule so `add -A` must check its worktree state (which chdirs via core.worktree).
    writeFileSync(join(wt, 'packages', 'shared', 'package.json'), '{"name":"@workspace/shared","x":1}');

    await expect(g(['-c', 'core.hooksPath=/dev/null', 'add', '-A'], wt)).rejects.toMatchObject({
      stderr: expect.stringMatching(/cannot chdir|failed in submodule/i),
    });
  });

  it('provisions a full clone for a submodule repo so `git add -A` succeeds after ensureSubmodules', async () => {
    const jobId = 'job-fix-1';
    const base = await git.createBaseWorktree(repo, jobId);
    const wt = base.worktreePath;
    expect(wt).toBe(join(mainClone, '.worktrees', `thread-${jobId}`));

    const sandbox = await git.switchBranch(base, repo, 'feature-fix');
    expect(sandbox.branch).toBe('feature-fix');

    await git.ensureSubmodules(wt, repo);

    // Real clone (DIR), not a linked-worktree pointer file.
    expect(statSync(join(wt, '.git')).isDirectory()).toBe(true);
    // Submodule gitdir lives under the clone's own `.git/modules/…`.
    expect(existsSync(join(wt, '.git', 'modules', 'packages', 'shared'))).toBe(true);

    // The core proof: `git add -A` no longer fatals.
    writeFileSync(join(wt, 'newfile.txt'), 'hello');
    await expect(g(['-c', 'core.hooksPath=/dev/null', 'add', '-A'], wt)).resolves.toBeTruthy();
    const status = await g(['status', '--porcelain'], wt);
    expect(status.stdout).toMatch(/^A\s+newfile\.txt$/m);
  });

  it('keeps the linked-worktree path unchanged for a repo without submodules', async () => {
    const { repo: repoNoSub, mainClone: mainCloneNoSub } = await buildNoSubmoduleFixture();
    const jobId = 'job-nosub-1';
    const base = await git.createBaseWorktree(repoNoSub, jobId);
    const wt = base.worktreePath;

    // A linked worktree's `.git` is a pointer FILE, not a directory.
    expect(statSync(join(wt, '.git')).isFile()).toBe(true);

    const list = await g(['worktree', 'list'], mainCloneNoSub);
    expect(list.stdout).toContain(wt);
  });

  it('removeSandbox rm -rf a full clone and leaves the main clone intact', async () => {
    const jobId = 'job-teardown-clone';
    const base = await git.createBaseWorktree(repo, jobId);
    const wt = base.worktreePath;
    expect(existsSync(wt)).toBe(true);

    await git.removeSandbox(repo, wt);

    expect(existsSync(wt)).toBe(false);
    expect(existsSync(join(mainClone, '.gitmodules'))).toBe(true);
    expect(existsSync(join(mainClone, '.git'))).toBe(true);
  });

  it('removeSandbox de-registers a linked worktree via `git worktree remove`', async () => {
    const { repo: repoNoSub, mainClone: mainCloneNoSub } = await buildNoSubmoduleFixture();
    const jobId = 'job-teardown-linked';
    const base = await git.createBaseWorktree(repoNoSub, jobId);
    const wt = base.worktreePath;

    await git.removeSandbox(repoNoSub, wt);

    expect(existsSync(wt)).toBe(false);
    const list = await g(['worktree', 'list'], mainCloneNoSub);
    expect(list.stdout).not.toContain(wt);
  });

  it('createBaseWorktree is idempotent — a second call at the same path reuses the clone', async () => {
    const jobId = 'job-resume-1';
    const base1 = await git.createBaseWorktree(repo, jobId);
    const marker = join(base1.worktreePath, '.marker');
    writeFileSync(marker, 'x');

    const base2 = await git.createBaseWorktree(repo, jobId);

    expect(base2.worktreePath).toBe(base1.worktreePath);
    // Untouched — proves the reuse path took effect (no teardown + re-provision on this call).
    expect(existsSync(marker)).toBe(true);
  });
});
