import { describe, expect, it } from 'bun:test';
import { join } from 'node:path';
import { jobContextDir } from '../paths.js';
import {
  WORKTREES_DIR,
  branchNameFor,
  jobCwd,
  mainWorktreeFromCommonDir,
  worktreeNameFor,
  worktreePathFor,
} from '../worktree.js';

describe('mainWorktreeFromCommonDir', () => {
  it('strips the trailing .git, which is what makes a linked worktree resolve to the main one', () => {
    // `--git-common-dir` is SHARED by every worktree, so this same answer comes back whether the
    // caller is in /repo or in /repo/.worktrees/foo — that is the whole point of using it.
    expect(mainWorktreeFromCommonDir('/repo/.git')).toBe('/repo');
  });

  it('tolerates the trailing newline git actually prints', () => {
    expect(mainWorktreeFromCommonDir('/repo/.git\n')).toBe('/repo');
  });

  it('tolerates a trailing separator', () => {
    expect(mainWorktreeFromCommonDir('/repo/.git/')).toBe('/repo');
  });

  it('leaves a bare repository alone — its common dir IS its root, with no .git to strip', () => {
    expect(mainWorktreeFromCommonDir('/srv/atlas.git')).toBe('/srv/atlas.git');
  });

  it('returns null for empty output, so a non-repository folder falls back to the path given', () => {
    expect(mainWorktreeFromCommonDir('  \n')).toBeNull();
  });
});

describe('worktreeNameFor', () => {
  it('names the directory for the job, keeping the title readable', () => {
    expect(worktreeNameFor({ title: 'Fix the drain', jobId: 'abcdef12-3456' })).toBe(
      'fix-the-drain-abcdef12',
    );
  });

  it('restricts to [a-z0-9-], sidestepping the whole ref grammar rather than policing it', () => {
    // `..`, `~^:?*[`, spaces and a trailing `.lock` are all illegal in a ref name; none of them can
    // survive a filter this narrow, so there is no rule left to get wrong.
    expect(worktreeNameFor({ title: 'a..b ~^:?*[ x.lock', jobId: 'deadbeef-0' })).toBe(
      'a-b-x-lock-deadbeef',
    );
  });

  it('falls back to a bare id when the title survives as nothing', () => {
    expect(worktreeNameFor({ title: '???', jobId: 'deadbeef-0' })).toBe('job-deadbeef');
  });

  it('truncates a long title without leaving a dangling separator', () => {
    const name = worktreeNameFor({ title: 'x'.repeat(200), jobId: 'deadbeef-0' });
    expect(name.length).toBeLessThanOrEqual(48);
    expect(name.endsWith('-deadbeef')).toBe(true);
    expect(name).not.toContain('--');
  });

  it('stays unique for two jobs sharing a title, because the id rides along', () => {
    const one = worktreeNameFor({ title: 'same', jobId: 'aaaaaaaa-1' });
    const two = worktreeNameFor({ title: 'same', jobId: 'bbbbbbbb-2' });
    expect(one).not.toBe(two);
  });
});

describe('branchNameFor', () => {
  it('namespaces every Atlas branch, so `git branch` says who made it', () => {
    expect(branchNameFor({ title: 'Fix the drain', jobId: 'abcdef12-3456' })).toBe(
      'atlas/fix-the-drain-abcdef12',
    );
  });
});

describe('worktreePathFor', () => {
  it('puts the worktree under the project path in a directory named for the job', () => {
    expect(worktreePathFor({ projectPath: '/repo', title: 'Fix it', jobId: 'abcdef12-3' })).toBe(
      join('/repo', WORKTREES_DIR, 'fix-it-abcdef12'),
    );
  });

  it('keeps nothing Atlas-related inside it — the context folder lives outside the repo entirely', () => {
    const worktree = worktreePathFor({ projectPath: '/repo', title: 't', jobId: 'j1' });
    expect(jobContextDir('j1').startsWith('/repo')).toBe(false);
    expect(worktree.startsWith('/repo')).toBe(true);
  });
});

describe('jobCwd', () => {
  it('runs a job without a worktree in the project path, exactly as before', () => {
    expect(jobCwd({ projectPath: '/repo', workspacePath: null })).toBe('/repo');
  });

  it('runs a job that took a worktree in the worktree', () => {
    expect(jobCwd({ projectPath: '/repo', workspacePath: '/repo/.worktrees/x' })).toBe(
      '/repo/.worktrees/x',
    );
  });
});
