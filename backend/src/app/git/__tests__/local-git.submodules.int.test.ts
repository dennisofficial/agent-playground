import type { EnvService } from '@core/config/env/env.service';
import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LocalGitService } from '../local-git.service';

const execFileAsync = promisify(execFile);

describe('LocalGitService — submodule hydration (real git, linked worktree)', () => {
  let root: string;
  let clone: string;
  let wt: string;
  let gitUrl: string;
  let git: LocalGitService;
  let prevAllowProtocol: string | undefined;

  const g = (args: string[], cwd: string) => execFileAsync('git', args, { cwd });

  beforeEach(async () => {
    prevAllowProtocol = process.env.GIT_ALLOW_PROTOCOL;
    process.env.GIT_ALLOW_PROTOCOL = 'file:https:ssh';

    root = mkdtempSync(join(tmpdir(), 'atlas-submod-'));
    git = new LocalGitService({
      get: () => undefined,
    } as unknown as EnvService);

    const subRemote = join(root, 'sub-remote');
    await execFileAsync('mkdir', ['-p', subRemote]);
    await g(['init', '-q', '-b', 'main'], subRemote);
    await g(['config', 'user.email', 'test@atlas.dev'], subRemote);
    await g(['config', 'user.name', 'Test'], subRemote);
    writeFileSync(join(subRemote, 'package.json'), '{"name":"@workspace/shared"}');
    await g(['add', '-A'], subRemote);
    await g(['commit', '-qm', 'sub'], subRemote);

    const superRemote = join(root, 'super-remote');
    await execFileAsync('mkdir', ['-p', superRemote]);
    await g(['init', '-q', '-b', 'main'], superRemote);
    await g(['config', 'user.email', 'test@atlas.dev'], superRemote);
    await g(['config', 'user.name', 'Test'], superRemote);
    writeFileSync(join(superRemote, 'README.md'), '# super');
    await g(
      [
        '-c',
        'protocol.file.allow=always',
        'submodule',
        'add',
        '-q',
        '../sub-remote',
        'packages/shared',
      ],
      superRemote,
    );
    await g(['add', '-A'], superRemote);
    await g(['commit', '-qm', 'super'], superRemote);

    gitUrl = `file://${superRemote}`;
    clone = join(root, 'clone');
    await g(['clone', '-q', gitUrl, clone], root);
    wt = join(clone, '.worktrees', 'feature');
    await g(['worktree', 'add', '-q', '--detach', wt, 'origin/main'], clone);
  });

  afterEach(() => {
    if (prevAllowProtocol === undefined) delete process.env.GIT_ALLOW_PROTOCOL;
    else process.env.GIT_ALLOW_PROTOCOL = prevAllowProtocol;
    rmSync(root, { recursive: true, force: true });
  });

  const submodulePkg = () => join(wt, 'packages', 'shared', 'package.json');

  it('leaves the submodule working tree EMPTY after a plain worktree cut (the bug)', () => {
    expect(existsSync(submodulePkg())).toBe(false);
  });

  it('populates the submodule working tree into the linked worktree', async () => {
    await git.ensureSubmodules(wt, { gitUrl });
    expect(existsSync(submodulePkg())).toBe(true);
    expect(readFileSync(submodulePkg(), 'utf8')).toContain('@workspace/shared');
    expect(
      existsSync(join(clone, '.git', 'worktrees', 'feature', 'modules', 'packages', 'shared')),
    ).toBe(true);
  });

  it('is idempotent — a healthy re-run is a clean no-op', async () => {
    await git.ensureSubmodules(wt, { gitUrl });
    await git.ensureSubmodules(wt, { gitUrl });
    expect(existsSync(submodulePkg())).toBe(true);
  });

  it('recovers a dangling per-worktree submodule gitdir (the cleared + re-cut corruption)', async () => {
    await git.ensureSubmodules(wt, { gitUrl });
    rmSync(join(clone, '.git', 'worktrees', 'feature', 'modules'), {
      recursive: true,
      force: true,
    });
    const status = await g(['status'], wt).then(
      () => 'ok',
      (err: { stderr?: string }) => err.stderr ?? 'err',
    );
    expect(status).toContain('not a git repository');

    await git.ensureSubmodules(wt, { gitUrl }); // deinit + reclone recovery
    expect(existsSync(submodulePkg())).toBe(true);
    await expect(g(['status'], wt)).resolves.toBeTruthy();
  });

  it('is a no-op for a repo without a .gitmodules', async () => {
    rmSync(join(wt, '.gitmodules'), { force: true });
    await expect(git.ensureSubmodules(wt, { gitUrl })).resolves.toBeUndefined();
  });
});

describe('clone-mode provisioning (submodule repos)', () => {
  let root: string;
  let superRemote: string;
  let subRemote: string;
  let gitUrl: string;
  let mainClone: string;
  let git: LocalGitService;
  let prevAllowProtocol: string | undefined;

  const g = (args: string[], cwd: string) => execFileAsync('git', args, { cwd });

  beforeEach(async () => {
    prevAllowProtocol = process.env.GIT_ALLOW_PROTOCOL;
    process.env.GIT_ALLOW_PROTOCOL = 'file:https:ssh';

    root = mkdtempSync(join(tmpdir(), 'atlas-clone-submod-'));
    git = new LocalGitService({
      get: () => undefined,
    } as unknown as EnvService);

    subRemote = join(root, 'sub-remote');
    await execFileAsync('mkdir', ['-p', subRemote]);
    await g(['init', '-q', '-b', 'main'], subRemote);
    await g(['config', 'user.email', 'test@atlas.dev'], subRemote);
    await g(['config', 'user.name', 'Test'], subRemote);
    writeFileSync(join(subRemote, 'package.json'), '{"name":"@workspace/shared"}');
    await g(['add', '-A'], subRemote);
    await g(['commit', '-qm', 'sub'], subRemote);

    superRemote = join(root, 'super-remote');
    await execFileAsync('mkdir', ['-p', superRemote]);
    await g(['init', '-q', '-b', 'main'], superRemote);
    await g(['config', 'user.email', 'test@atlas.dev'], superRemote);
    await g(['config', 'user.name', 'Test'], superRemote);
    writeFileSync(join(superRemote, 'README.md'), '# super');
    await g(
      [
        '-c',
        'protocol.file.allow=always',
        'submodule',
        'add',
        '-q',
        '../sub-remote',
        'packages/shared',
      ],
      superRemote,
    );
    await g(['add', '-A'], superRemote);
    await g(['commit', '-qm', 'super'], superRemote);

    gitUrl = `file://${superRemote}`;
    mainClone = join(root, 'main-clone');
    await g(['clone', '-q', gitUrl, mainClone], root);
  });

  afterEach(() => {
    if (prevAllowProtocol === undefined) delete process.env.GIT_ALLOW_PROTOCOL;
    else process.env.GIT_ALLOW_PROTOCOL = prevAllowProtocol;
    rmSync(root, { recursive: true, force: true });
  });

  const repo = () => ({
    repoId: 'test-repo',
    gitUrl,
    defaultBranch: 'main',
    repoPath: mainClone,
  });

  it('hasSubmodules is true for a repo with .gitmodules at its base branch', async () => {
    expect(await git.hasSubmodules(repo())).toBe(true);
  });

  it('hasSubmodules is false for a repo without .gitmodules', async () => {
    const noSubRemote = join(root, 'nosub-remote');
    await execFileAsync('mkdir', ['-p', noSubRemote]);
    await g(['init', '-q', '-b', 'main'], noSubRemote);
    await g(['config', 'user.email', 'test@atlas.dev'], noSubRemote);
    await g(['config', 'user.name', 'Test'], noSubRemote);
    writeFileSync(join(noSubRemote, 'README.md'), '# plain');
    await g(['add', '-A'], noSubRemote);
    await g(['commit', '-qm', 'plain'], noSubRemote);
    const noSubClone = join(root, 'nosub-clone');
    await g(['clone', '-q', `file://${noSubRemote}`, noSubClone], root);

    expect(
      await git.hasSubmodules({
        repoId: 'nosub-repo',
        gitUrl: `file://${noSubRemote}`,
        defaultBranch: 'main',
        repoPath: noSubClone,
      }),
    ).toBe(false);
  });

  it('createBaseClone provisions a real full clone (.git is a directory, not a gitlink file)', async () => {
    const sandbox = await git.createBaseClone(repo(), 'job-1');
    expect(statSync(join(sandbox.worktreePath, '.git')).isDirectory()).toBe(true);
  });

  it('ensureSubmodules resolves the submodule with a relative gitdir under .git/modules', async () => {
    const sandbox = await git.createBaseClone(repo(), 'job-2');
    await git.ensureSubmodules(sandbox.worktreePath, repo());

    const subPath = join(sandbox.worktreePath, 'packages', 'shared');
    await expect(
      execFileAsync('git', ['-C', subPath, 'rev-parse', '--absolute-git-dir']),
    ).resolves.toBeTruthy();

    const gitlink = readFileSync(join(subPath, '.git'), 'utf8').trim();
    expect(gitlink.startsWith('gitdir: ../')).toBe(true);

    const gitdirRel = gitlink.replace(/^gitdir:\s*/, '');
    const resolvedGitdir = join(subPath, gitdirRel);
    expect(resolvedGitdir.startsWith(join(sandbox.worktreePath, '.git', 'modules'))).toBe(true);
  });

  it("removeSandbox rm -rf's a clone checkout entirely", async () => {
    const sandbox = await git.createBaseClone(repo(), 'job-3');
    expect(existsSync(sandbox.worktreePath)).toBe(true);
    await git.removeSandbox(repo(), sandbox.worktreePath);
    expect(existsSync(sandbox.worktreePath)).toBe(false);
  });
});
