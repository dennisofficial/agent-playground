import { describe, expect, it } from 'bun:test';
import { EWorkspaceKind, workspaceState } from '../worktree.js';

describe('workspaceState', () => {
  it('names the branch a job took its own worktree on', () => {
    expect(
      workspaceState({
        branch: 'atlas/fix-steering',
        workspacePath: '/repo/.worktrees/fix-steering-a1b2',
        checkoutBranch: 'atlas/fix-steering',
        workspaceExists: true,
      }),
    ).toEqual({
      kind: EWorkspaceKind.worktree,
      glyph: '⑂',
      label: 'atlas/fix-steering',
    });
  });

  it('says in place, and which branch, when the job never took one', () => {
    // The important half. Working in place means the agent commits into the tree the editor is open
    // on, so the branch it will commit to is the one fact the page owes you.
    expect(
      workspaceState({
        branch: null,
        workspacePath: null,
        checkoutBranch: 'main',
        workspaceExists: false,
      }),
    ).toEqual({
      kind: EWorkspaceKind.inPlace,
      glyph: '⌂',
      label: 'main · in place',
    });
  });

  it('still says in place when git cannot name a branch', () => {
    // Detached head, or a folder that is not a repository at all. Neither is an error here — plenty
    // of jobs run in a directory git has never heard of.
    expect(
      workspaceState({
        branch: null,
        workspacePath: null,
        checkoutBranch: null,
        workspaceExists: false,
      }),
    ).toEqual({ kind: EWorkspaceKind.inPlace, glyph: '⌂', label: 'in place' });
  });

  it('treats a recorded worktree that is gone from disk as the warning it is', () => {
    // Never silently falls back to "in place": the whole reason the worktree existed was to keep the
    // agent out of the tree it would fall back INTO, so a quiet downgrade is the dangerous answer.
    expect(
      workspaceState({
        branch: 'atlas/fix-steering',
        workspacePath: '/repo/.worktrees/gone',
        checkoutBranch: null,
        workspaceExists: false,
      }),
    ).toEqual({
      kind: EWorkspaceKind.missing,
      glyph: '⚠',
      label: 'worktree missing: /repo/.worktrees/gone',
    });
  });

  it('reads a branch with no worktree as in place — the branch outlives the directory', () => {
    // `release()` removes the tree and deliberately leaves the branch, so this pairing is normal
    // rather than corrupt: the job is back in the project path, on whatever is checked out there.
    expect(
      workspaceState({
        branch: 'atlas/fix-steering',
        workspacePath: null,
        checkoutBranch: 'main',
        workspaceExists: false,
      }),
    ).toEqual({
      kind: EWorkspaceKind.inPlace,
      glyph: '⌂',
      label: 'main · in place',
    });
  });
});
