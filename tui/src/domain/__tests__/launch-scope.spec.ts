import { describe, expect, it } from 'bun:test';
import { ELaunchScope, launchScope } from '../launch-scope.js';

describe('launchScope', () => {
  it('scopes to the repo when you launch inside one', () => {
    expect(
      launchScope({ explicitPath: null, cwd: '/Users/d/Developer/atlas/tui', gitRoot: '/Users/d/Developer/atlas' }),
    ).toEqual({ kind: ELaunchScope.project, path: '/Users/d/Developer/atlas' });
  });

  it('scopes to the repo, not the worktree, when you launch inside a linked worktree', () => {
    // Project identity is the MAIN worktree, whatever corner of the repository you opened. Anything
    // else mints a second project with its own job list for the same repo.
    expect(
      launchScope({
        explicitPath: null,
        cwd: '/Users/d/Developer/atlas/.worktrees/fix-steering',
        gitRoot: '/Users/d/Developer/atlas',
      }),
    ).toEqual({ kind: ELaunchScope.project, path: '/Users/d/Developer/atlas' });
  });

  it('goes global when you launch somewhere that is not a repo', () => {
    // The load-bearing rule. Launching from ~ is the NORMAL case, and minting a project for the
    // home directory would put a junk row at the top of the list forever.
    expect(launchScope({ explicitPath: null, cwd: '/Users/d', gitRoot: null })).toEqual({
      kind: ELaunchScope.global,
    });
  });

  it('honours an explicitly named folder even when it is not a repo', () => {
    // `atlas <path>` is a statement of intent — the user named this folder, so it becomes a project
    // whether or not git has ever heard of it. Only the IMPLICIT cwd is treated as a mere hint.
    expect(launchScope({ explicitPath: '/tmp/scratch', cwd: '/Users/d', gitRoot: null })).toEqual({
      kind: ELaunchScope.project,
      path: '/tmp/scratch',
    });
  });

  it('prefers the git root of an explicitly named folder', () => {
    expect(
      launchScope({
        explicitPath: '/Users/d/Developer/atlas/tui',
        cwd: '/Users/d',
        gitRoot: '/Users/d/Developer/atlas',
      }),
    ).toEqual({ kind: ELaunchScope.project, path: '/Users/d/Developer/atlas' });
  });

  it('ignores cwd entirely once a folder is named', () => {
    const named = launchScope({ explicitPath: '/tmp/a', cwd: '/tmp/b', gitRoot: null });
    expect(named).toEqual({ kind: ELaunchScope.project, path: '/tmp/a' });
  });
});
