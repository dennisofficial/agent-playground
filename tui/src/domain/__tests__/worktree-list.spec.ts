import { describe, expect, it } from 'bun:test';
import { parseWorktreeList } from '../worktree-list.js';

describe('parseWorktreeList', () => {
  it('reads the main worktree git actually prints', () => {
    const parsed = parseWorktreeList(
      'worktree /repo\nHEAD 5dde6018d69393fb763378c77bcfe04134492c91\nbranch refs/heads/feat/atlas-v2\n',
    );
    expect(parsed).toEqual([
      {
        path: '/repo',
        head: '5dde6018d69393fb763378c77bcfe04134492c91',
        branch: 'feat/atlas-v2',
        bare: false,
        detached: false,
        locked: false,
        prunable: false,
      },
    ]);
  });

  it('separates records and keeps git’s order, main worktree first', () => {
    const parsed = parseWorktreeList(
      [
        'worktree /repo',
        'HEAD aaa',
        'branch refs/heads/main',
        '',
        'worktree /repo/.worktrees/fix-the-drain-abcdef12',
        'HEAD bbb',
        'branch refs/heads/atlas/fix-the-drain-abcdef12',
        '',
      ].join('\n'),
    );
    expect(parsed.map((w) => w.path)).toEqual(['/repo', '/repo/.worktrees/fix-the-drain-abcdef12']);
    expect(parsed.map((w) => w.branch)).toEqual(['main', 'atlas/fix-the-drain-abcdef12']);
  });

  it('opens a record on `worktree`, so a missing blank line cannot fuse two into one', () => {
    // The separator is presentation; the opener is structure. Keying off the opener is what makes
    // this true, and it is the only reason to prefer it.
    const parsed = parseWorktreeList('worktree /a\nHEAD aaa\nworktree /b\nHEAD bbb\n');
    expect(parsed.map((w) => w.path)).toEqual(['/a', '/b']);
    expect(parsed.map((w) => w.head)).toEqual(['aaa', 'bbb']);
  });

  it('leaves branch null on a detached head and records the flag', () => {
    const parsed = parseWorktreeList('worktree /repo/wt\nHEAD abc1234def\ndetached\n');
    expect(parsed[0]?.branch).toBeNull();
    expect(parsed[0]?.detached).toBe(true);
  });

  it('records a bare repository, which has no HEAD and no branch', () => {
    const parsed = parseWorktreeList('worktree /srv/atlas.git\nbare\n');
    expect(parsed[0]).toMatchObject({ path: '/srv/atlas.git', bare: true, head: null, branch: null });
  });

  it('records `locked` and `prunable` with or without git’s reason on the line', () => {
    const parsed = parseWorktreeList(
      [
        'worktree /a',
        'HEAD aaa',
        'locked',
        '',
        'worktree /b',
        'HEAD bbb',
        'prunable gitdir file points to non-existent location',
        '',
      ].join('\n'),
    );
    expect(parsed[0]?.locked).toBe(true);
    expect(parsed[1]?.prunable).toBe(true);
  });

  it('keeps a branch ref that is not under refs/heads verbatim rather than mangling it', () => {
    const parsed = parseWorktreeList('worktree /a\nHEAD aaa\nbranch refs/remotes/origin/main\n');
    expect(parsed[0]?.branch).toBe('refs/remotes/origin/main');
  });

  it('tolerates the trailing \\r of a Windows checkout without eating the path', () => {
    const parsed = parseWorktreeList('worktree /repo\r\nHEAD aaa\r\nbranch refs/heads/main\r\n');
    expect(parsed[0]).toMatchObject({ path: '/repo', head: 'aaa', branch: 'main' });
  });

  it('returns nothing for empty output — a folder git has never heard of', () => {
    expect(parseWorktreeList('')).toEqual([]);
    expect(parseWorktreeList('\n\n')).toEqual([]);
  });

  it('ignores attribute lines with no record open, which only a truncated read produces', () => {
    expect(parseWorktreeList('HEAD aaa\nbranch refs/heads/main\n')).toEqual([]);
  });
});
