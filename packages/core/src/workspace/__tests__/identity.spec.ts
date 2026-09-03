import { describe, expect, it } from 'bun:test'

import { launchWorktreeOf, workspaceFrom } from '../identity'

describe('workspaceFrom', () => {
  it('takes the toplevel as the workspace when git reports one', () => {
    expect(
      workspaceFrom({
        cwd: '/Users/dev/atlas/apps/tui',
        toplevel: '/Users/dev/atlas',
        commonDir: '/Users/dev/atlas/.git',
      }),
    ).toEqual({ workspace: '/Users/dev/atlas', repo: '/Users/dev/atlas' })
  })

  it('separates a linked worktree from the repo it belongs to', () => {
    expect(
      workspaceFrom({
        cwd: '/Users/dev/wt/feature',
        toplevel: '/Users/dev/wt/feature',
        commonDir: '/Users/dev/atlas/.git',
      }),
    ).toEqual({ workspace: '/Users/dev/wt/feature', repo: '/Users/dev/atlas' })
  })

  it('keeps two worktrees of one repo apart', () => {
    const one = workspaceFrom({
      cwd: '/Users/dev/wt/a',
      toplevel: '/Users/dev/wt/a',
      commonDir: '/Users/dev/atlas/.git',
    })
    const other = workspaceFrom({
      cwd: '/Users/dev/wt/b',
      toplevel: '/Users/dev/wt/b',
      commonDir: '/Users/dev/atlas/.git',
    })

    expect(one.workspace).not.toBe(other.workspace)
    expect(one.repo).toBe(other.repo)
  })

  it('falls back to the cwd exactly when git reports nothing', () => {
    expect(workspaceFrom({ cwd: '/Users/dev/Documents/work' })).toEqual({
      workspace: '/Users/dev/Documents/work',
      repo: null,
    })
  })

  it('does not climb to a parent project when there is no git', () => {
    expect(workspaceFrom({ cwd: '/Users/dev/Documents/work' }).workspace).toBe(
      '/Users/dev/Documents/work',
    )
  })

  it('falls back to the cwd when the toplevel is empty, as a bare repo reports', () => {
    expect(workspaceFrom({ cwd: '/Users/dev/bare', toplevel: '', commonDir: '/Users/dev/bare' })).toEqual(
      { workspace: '/Users/dev/bare', repo: null },
    )
  })

  it('strips a trailing slash so one directory is one workspace', () => {
    expect(workspaceFrom({ cwd: '/Users/dev/atlas/', toplevel: '/Users/dev/atlas/' })).toEqual({
      workspace: '/Users/dev/atlas',
      repo: null,
    })
  })

  it('leaves the filesystem root alone', () => {
    expect(workspaceFrom({ cwd: '/' }).workspace).toBe('/')
  })

  it('reports no repo when the common dir is relative, because it cannot be resolved here', () => {
    expect(
      workspaceFrom({ cwd: '/Users/dev/atlas', toplevel: '/Users/dev/atlas', commonDir: '.git' })
        .repo,
    ).toBeNull()
  })

  it('reads the repo as the parent of the common dir', () => {
    expect(
      workspaceFrom({
        cwd: '/Users/dev/atlas',
        toplevel: '/Users/dev/atlas',
        commonDir: '/Users/dev/atlas/.git/',
      }).repo,
    ).toBe('/Users/dev/atlas')
  })
})

describe('launchWorktreeOf', () => {
  it('names the worktree when the workspace is not the repo', () => {
    expect(
      launchWorktreeOf({ workspace: '/Users/dev/wt/feature', repo: '/Users/dev/atlas' }),
    ).toBe('/Users/dev/wt/feature')
  })

  it('names nothing on the main checkout, where workspace and repo are one', () => {
    expect(launchWorktreeOf({ workspace: '/Users/dev/atlas', repo: '/Users/dev/atlas' })).toBeNull()
  })

  it('names nothing outside git', () => {
    expect(launchWorktreeOf({ workspace: '/Users/dev/Documents/work', repo: null })).toBeNull()
  })
})
