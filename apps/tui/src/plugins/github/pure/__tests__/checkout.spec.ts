import { describe, expect, it } from 'bun:test'

import { checkoutKey, checkoutOf, EForge } from '../checkout'

const DIRECTORY = '/work/atlas'

describe('checkoutOf', () => {
  it('prefers origin over upstream and over the first remote', () => {
    const checkout = checkoutOf({
      directory: DIRECTORY,
      branch: 'feature-x',
      remotes: [
        { name: 'fork', url: 'git@github.com:someone/atlas.git' },
        { name: 'upstream', url: 'git@github.com:upstream-owner/atlas.git' },
        { name: 'origin', url: 'git@github.com:dennisofficial/atlas.git' },
      ],
    })

    expect(checkout?.remote.owner).toBe('dennisofficial')
    expect(checkout?.forge).toBe(EForge.GitHub)
  })

  it('falls back to upstream when there is no origin', () => {
    const checkout = checkoutOf({
      directory: DIRECTORY,
      branch: 'main',
      remotes: [
        { name: 'fork', url: 'git@github.com:someone/atlas.git' },
        { name: 'upstream', url: 'git@github.com:upstream-owner/atlas.git' },
      ],
    })

    expect(checkout?.remote.owner).toBe('upstream-owner')
  })

  it('falls back to the first remote that parses', () => {
    const checkout = checkoutOf({
      directory: DIRECTORY,
      branch: 'main',
      remotes: [
        { name: 'mirror', url: '/Users/x/mirror.git' },
        { name: 'fork', url: 'https://github.com/someone/atlas.git' },
      ],
    })

    expect(checkout?.remote.owner).toBe('someone')
  })

  it('is null with no remotes, with no branch, and with nothing parseable', () => {
    expect(checkoutOf({ directory: DIRECTORY, branch: 'main', remotes: [] })).toBeNull()
    expect(
      checkoutOf({
        directory: DIRECTORY,
        branch: '',
        remotes: [{ name: 'origin', url: 'git@github.com:o/r.git' }],
      }),
    ).toBeNull()
    expect(
      checkoutOf({
        directory: DIRECTORY,
        branch: 'main',
        remotes: [{ name: 'origin', url: '/Users/x/mirror.git' }],
      }),
    ).toBeNull()
  })

  it('reads the forge off the host', () => {
    const gitlab = checkoutOf({
      directory: DIRECTORY,
      branch: 'main',
      remotes: [{ name: 'origin', url: 'https://gitlab.com/group/sub/proj.git' }],
    })
    const corporate = checkoutOf({
      directory: DIRECTORY,
      branch: 'main',
      remotes: [{ name: 'origin', url: 'git@git.acme-corp.internal:team/proj.git' }],
    })

    expect(gitlab?.forge).toBe(EForge.Other)
    expect(corporate?.forge).toBe(EForge.Unknown)
  })
})

describe('checkoutKey', () => {
  it('keys on the remote and the branch, never the directory', () => {
    const inWorktree = checkoutOf({
      directory: '/work/atlas/.claude/worktrees/thing',
      branch: 'feature-x',
      remotes: [{ name: 'origin', url: 'git@github.com:dennisofficial/atlas.git' }],
    })
    const inRoot = checkoutOf({
      directory: DIRECTORY,
      branch: 'feature-x',
      remotes: [{ name: 'origin', url: 'git@github.com:dennisofficial/atlas.git' }],
    })

    expect(inWorktree).not.toBeNull()
    expect(inRoot).not.toBeNull()
    if (inWorktree === null || inRoot === null) return

    expect(checkoutKey(inWorktree)).toBe('github.com/dennisofficial/atlas#feature-x')
    expect(checkoutKey(inWorktree)).toBe(checkoutKey(inRoot))
  })
})
