import { describe, expect, it } from 'bun:test'

import { theme } from '../theme'
import {
  headerBarModel,
  headerLocation,
  parseShortStat,
} from '../header-bar'

describe('parseShortStat', () => {
  it('reads insertions and deletions together', () => {
    expect(parseShortStat(' 3 files changed, 12 insertions(+), 4 deletions(-)\n')).toEqual({
      added: 12,
      removed: 4,
    })
  })

  it('reads an insertions-only line', () => {
    expect(parseShortStat(' 1 file changed, 7 insertions(+)\n')).toEqual({ added: 7, removed: 0 })
  })

  it('reads a deletions-only line', () => {
    expect(parseShortStat(' 2 files changed, 9 deletions(-)\n')).toEqual({ added: 0, removed: 9 })
  })

  it('reads a zero-change line', () => {
    expect(parseShortStat(' 1 file changed, 0 insertions(+), 0 deletions(-)\n')).toEqual({
      added: 0,
      removed: 0,
    })
  })

  it('says nothing for a clean tree, which prints nothing', () => {
    expect(parseShortStat('')).toBeNull()
  })

  it('says nothing for an error message', () => {
    expect(parseShortStat('fatal: ambiguous argument HEAD')).toBeNull()
  })
})

describe('headerLocation', () => {
  const repoRoot = '/work/atlas'

  it('names the repo when the session runs in place', () => {
    expect(headerLocation({ projectDirectory: repoRoot, repoRoot, home: '/home/d' })).toEqual({
      inPlace: true,
      label: 'atlas',
    })
  })

  it('relativizes a worktree under the repo root', () => {
    expect(
      headerLocation({
        projectDirectory: `${repoRoot}/.claude/worktrees/transcript-header`,
        repoRoot,
        home: '/home/d',
      }),
    ).toEqual({ inPlace: false, label: '.claude/worktrees/transcript-header' })
  })

  it('collapses home for a directory outside the repo', () => {
    expect(
      headerLocation({ projectDirectory: '/home/d/tmp/scratch', repoRoot, home: '/home/d' }),
    ).toEqual({ inPlace: false, label: '~/tmp/scratch' })
  })
})

describe('headerBarModel', () => {
  const atWorktree = { inPlace: false, label: '.claude/worktrees/transcript-header' }

  it('puts the worktree location first and the diff last', () => {
    const model = headerBarModel({
      location: atWorktree,
      diff: { added: 12, removed: 4 },
      cells: 120,
    })

    expect(model.left.map((span) => span.text).join('')).toBe(
      '⑂ .claude/worktrees/transcript-header',
    )
    expect(model.left[0]?.fg).toBe(theme.accent)
    expect(model.left[2]?.fg).toBe(theme.accent)
    expect(model.right.map((span) => span.text).join('')).toBe('+12  -4')
    expect(model.right[0]?.fg).toBe(theme.okBright)
    expect(model.right[2]?.fg).toBe(theme.error)
  })

  it('uses the home glyph in place', () => {
    const model = headerBarModel({
      location: { inPlace: true, label: 'atlas' },
      diff: null,
      cells: 120,
    })

    expect(model.left.map((span) => span.text).join('')).toBe('⌂ atlas')
    expect(model.right).toEqual([])
  })

  it('shows a grey +0 -0 for a clean tree', () => {
    const model = headerBarModel({
      location: atWorktree,
      diff: { added: 0, removed: 0 },
      cells: 120,
    })

    expect(model.right.map((span) => span.text).join('')).toBe('+0  -0')
    expect(model.right[0]?.fg).toBe(theme.dim)
    expect(model.right[2]?.fg).toBe(theme.dim)
  })

  it('greys only the zero side of a one-sided diff', () => {
    const model = headerBarModel({
      location: atWorktree,
      diff: { added: 5, removed: 0 },
      cells: 120,
    })

    expect(model.right[0]?.fg).toBe(theme.okBright)
    expect(model.right[2]?.fg).toBe(theme.dim)
  })

  it('drops the diff entirely when git has no answer', () => {
    const model = headerBarModel({
      location: atWorktree,
      diff: null,
      cells: 120,
    })

    expect(model.right).toEqual([])
  })

  it('shortens the location before letting it touch the diff', () => {
    const model = headerBarModel({
      location: atWorktree,
      diff: { added: 12, removed: 4 },
      cells: 20,
    })

    const leftCells = model.left.reduce((total, span) => total + span.text.length, 0)
    const rightCells = model.right.reduce((total, span) => total + span.text.length, 0)
    expect(leftCells + 1 + rightCells).toBeLessThanOrEqual(20)
  })
})
