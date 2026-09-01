import { afterAll, describe, expect, it } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { repositoryRootOf } from '../repository-root'

const root = mkdtempSync(join(tmpdir(), 'atlas-repository-root-'))

afterAll(() => {
  rmSync(root, { recursive: true, force: true })
})

const directory = (...segments: string[]): string => {
  const path = join(root, ...segments)
  mkdirSync(path, { recursive: true })
  return path
}

describe('finding the repository a directory belongs to', () => {
  it('walks up to the directory holding .git', () => {
    const repository = directory('repo')
    mkdirSync(join(repository, '.git'))
    const nested = directory('repo', 'packages', 'harness')

    expect(repositoryRootOf({ from: nested })).toBe(repository)
  })

  it('answers with the directory itself when that is where .git lives', () => {
    const repository = directory('at-the-top')
    mkdirSync(join(repository, '.git'))

    expect(repositoryRootOf({ from: repository })).toBe(repository)
  })

  it('accepts the .git file a linked worktree carries instead of a directory', () => {
    const tree = directory('linked-worktree')
    writeFileSync(join(tree, '.git'), 'gitdir: /elsewhere/.git/worktrees/topic\n')
    const nested = directory('linked-worktree', 'apps', 'tui')

    expect(repositoryRootOf({ from: nested })).toBe(tree)
  })

  it('falls back to the directory it started from when nothing above is a repository', () => {
    const loose = directory('no-repository-here')

    expect(repositoryRootOf({ from: loose })).toBe(loose)
  })

  it('stops at the nearest repository rather than an outer one', () => {
    const outer = directory('outer')
    mkdirSync(join(outer, '.git'))
    const inner = directory('outer', 'vendor', 'inner')
    mkdirSync(join(inner, '.git'))

    expect(repositoryRootOf({ from: join(inner, 'src') })).toBe(inner)
  })
})
