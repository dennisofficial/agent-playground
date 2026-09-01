import { afterAll, describe, expect, it } from 'bun:test'
import { mkdtemp, rm, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { parseWorktreePorcelain, parseStatusPorcelain } from '../worktrees-parse'
import {
  addWorktree,
  defaultBranch,
  EDefaultBranchSource,
  EWorktreeAddFailure,
  fetchOrigin,
  inspectWorktree,
  listWorktrees,
  pruneWorktrees,
  removeWorktree,
} from '../worktrees'

const made: string[] = []

const scratch = async (): Promise<string> => {
  const path = await realpath(await mkdtemp(join(tmpdir(), 'atlas-worktrees-')))
  made.push(path)
  return path
}

const git = async (args: readonly string[], cwd: string): Promise<void> => {
  const proc = Bun.spawn(['git', ...args], { cwd, stdout: 'ignore', stderr: 'ignore' })
  const status = await proc.exited
  if (status !== 0) throw new Error(`git ${args.join(' ')} failed in ${cwd}`)
}

const repoWithCommit = async (): Promise<string> => {
  const root = await scratch()
  await git(['init', '-b', 'main'], root)
  await git(['config', 'user.email', 'test@example.com'], root)
  await git(['config', 'user.name', 'Test'], root)
  await Bun.write(join(root, 'README.md'), 'hello')
  await git(['add', '.'], root)
  await git(['commit', '-m', 'initial'], root)
  return root
}

afterAll(async () => {
  await Promise.all(made.map((path) => rm(path, { recursive: true, force: true })))
})

describe('parseWorktreePorcelain', () => {
  it('reads a fixture with attached, detached and locked records', () => {
    const output = [
      'worktree /repo',
      'HEAD aaaa111',
      'branch refs/heads/main',
      '',
      'worktree /repo/.claude/worktrees/spike',
      'HEAD bbbb222',
      'detached',
      'locked on a usb drive',
      '',
      'worktree /gone',
      'HEAD cccc333',
      'branch refs/heads/gone',
      'prunable gitdir file points to non-existent location',
      '',
    ].join('\n')

    expect(parseWorktreePorcelain({ output })).toEqual([
      {
        path: '/repo',
        head: 'aaaa111',
        branch: 'main',
        isMain: true,
        isBare: false,
        isDetached: false,
        isLocked: false,
        lockedReason: undefined,
        isPrunable: false,
        prunableReason: undefined,
      },
      {
        path: '/repo/.claude/worktrees/spike',
        head: 'bbbb222',
        branch: undefined,
        isMain: false,
        isBare: false,
        isDetached: true,
        isLocked: true,
        lockedReason: 'on a usb drive',
        isPrunable: false,
        prunableReason: undefined,
      },
      {
        path: '/gone',
        head: 'cccc333',
        branch: 'gone',
        isMain: false,
        isBare: false,
        isDetached: false,
        isLocked: false,
        lockedReason: undefined,
        isPrunable: true,
        prunableReason: 'gitdir file points to non-existent location',
      },
    ])
  })

  it('marks a bare main worktree and a reasonless lock', () => {
    const output = ['worktree /bare', 'bare', '', 'worktree /wt', 'HEAD dd44', 'locked', ''].join(
      '\n',
    )
    const [bare, locked] = parseWorktreePorcelain({ output })

    expect(bare?.isBare).toBe(true)
    expect(bare?.isMain).toBe(true)
    expect(locked?.isLocked).toBe(true)
    expect(locked?.lockedReason).toBeUndefined()
  })
})

describe('parseStatusPorcelain', () => {
  it('reads changed paths and the destination of a rename', () => {
    const output = [' M src/a.ts', '?? notes.md', 'R  old.ts -> new.ts', ''].join('\n')

    expect(parseStatusPorcelain({ output })).toEqual(['src/a.ts', 'notes.md', 'new.ts'])
  })
})

describe('listWorktrees', () => {
  it('names the main worktree of a repo with only one', async () => {
    const root = await repoWithCommit()

    const listing = await listWorktrees({ cwd: root })

    expect(listing.ok).toBe(true)
    if (!listing.ok) return
    expect(listing.worktrees).toHaveLength(1)
    expect(listing.worktrees[0]?.path).toBe(root)
    expect(listing.worktrees[0]?.branch).toBe('main')
    expect(listing.worktrees[0]?.isMain).toBe(true)
    expect(listing.worktrees[0]?.head).toMatch(/^[0-9a-f]{40}$/)
  })

  it('lists several worktrees with canonical paths, the main one first', async () => {
    const root = await repoWithCommit()
    const first = join(await scratch(), 'one')
    const second = join(await scratch(), 'two')
    await git(['worktree', 'add', first, '-b', 'one'], root)
    await git(['worktree', 'add', second, '-b', 'two'], root)

    const listing = await listWorktrees({ cwd: first })

    expect(listing.ok).toBe(true)
    if (!listing.ok) return
    const [main, ...linked] = listing.worktrees
    expect(main?.path).toBe(root)
    expect(main?.branch).toBe('main')
    expect(main?.isMain).toBe(true)
    expect(linked.map((worktree) => worktree.path).sort()).toEqual(
      [await realpath(first), await realpath(second)].sort(),
    )
    expect(linked.map((worktree) => worktree.branch).sort()).toEqual(['one', 'two'])
    expect(linked.every((worktree) => !worktree.isMain)).toBe(true)
  })

  it('reports a failure outside a repo rather than throwing', async () => {
    const loose = await scratch()

    const listing = await listWorktrees({ cwd: loose })

    expect(listing.ok).toBe(false)
    if (listing.ok) return
    expect(listing.message.length).toBeGreaterThan(0)
  })
})

describe('defaultBranch', () => {
  it('falls back to the local main when there is no origin', async () => {
    const root = await repoWithCommit()

    expect(await defaultBranch({ cwd: root })).toEqual({
      ok: true,
      branch: 'main',
      source: EDefaultBranchSource.LocalBranch,
    })
  })

  it('could not determine a branch in a repo with neither main nor master', async () => {
    const root = await repoWithCommit()
    await git(['branch', '-m', 'main', 'trunk'], root)

    const result = await defaultBranch({ cwd: root })

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.message).toContain('could not determine')
  })
})

describe('addWorktree', () => {
  it('creates the worktree and reports its canonical path', async () => {
    const root = await repoWithCommit()
    const target = join(await scratch(), 'feature')

    const result = await addWorktree({ cwd: root, path: target, branch: 'feature', base: 'main' })

    expect(result).toEqual({ ok: true, path: await realpath(target), branch: 'feature' })
  })

  it('refuses a branch that already exists', async () => {
    const root = await repoWithCommit()
    const first = join(await scratch(), 'a')
    const second = join(await scratch(), 'b')
    await addWorktree({ cwd: root, path: first, branch: 'dupe', base: 'main' })

    const result = await addWorktree({ cwd: root, path: second, branch: 'dupe', base: 'main' })

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.failure).toBe(EWorktreeAddFailure.BranchExists)
    expect(result.message).toContain('dupe')
  })

  it('tells an unknown base apart from an occupied path', async () => {
    const root = await repoWithCommit()
    const target = join(await scratch(), 'nope')

    const missingBase = await addWorktree({
      cwd: root,
      path: target,
      branch: 'nope',
      base: 'origin/nowhere',
    })
    await addWorktree({ cwd: root, path: target, branch: 'taken', base: 'main' })
    const occupied = await addWorktree({ cwd: root, path: target, branch: 'other', base: 'main' })

    expect(missingBase.ok).toBe(false)
    if (missingBase.ok) return
    expect(missingBase.failure).toBe(EWorktreeAddFailure.UnknownBase)
    expect(occupied.ok).toBe(false)
    if (occupied.ok) return
    expect(occupied.failure).toBe(EWorktreeAddFailure.PathExists)
  })
})

describe('fetchOrigin', () => {
  it('reports a failure without throwing when there is no origin', async () => {
    const root = await repoWithCommit()

    const outcome = await fetchOrigin({ cwd: root })

    expect(outcome.ok).toBe(false)
  })
})

describe('inspectWorktree', () => {
  it('sees an uncommitted file', async () => {
    const root = await repoWithCommit()
    await Bun.write(join(root, 'scratch.txt'), 'wip')

    const inspection = await inspectWorktree({ cwd: root, base: 'main' })

    expect(inspection.isClean).toBe(false)
    expect(inspection.changedCount).toBe(1)
    expect(inspection.changedPaths).toEqual(['scratch.txt'])
  })

  it('sees a clean tree with nothing ahead of its base', async () => {
    const root = await repoWithCommit()
    const target = join(await scratch(), 'clean')
    await addWorktree({ cwd: root, path: target, branch: 'clean', base: 'main' })

    expect(await inspectWorktree({ cwd: target, base: 'main' })).toEqual({
      isClean: true,
      changedPaths: [],
      changedCount: 0,
      unpushedCommits: 0,
      comparedAgainst: 'main',
    })
  })

  it('counts commits the branch has beyond its base', async () => {
    const root = await repoWithCommit()
    const target = join(await scratch(), 'ahead')
    await addWorktree({ cwd: root, path: target, branch: 'ahead', base: 'main' })
    await Bun.write(join(target, 'new.txt'), 'work')
    await git(['add', '.'], target)
    await git(['commit', '-m', 'work'], target)

    const inspection = await inspectWorktree({ cwd: target, base: 'main' })

    expect(inspection.unpushedCommits).toBe(1)
    expect(inspection.comparedAgainst).toBe('main')
    expect(inspection.isClean).toBe(false)
  })
})

describe('removeWorktree', () => {
  it('refuses a dirty worktree without force and leaves the branch alone', async () => {
    const root = await repoWithCommit()
    const target = join(await scratch(), 'dirty')
    await addWorktree({ cwd: root, path: target, branch: 'dirty', base: 'main' })
    await Bun.write(join(target, 'unsaved.txt'), 'wip')

    const removal = await removeWorktree({
      cwd: root,
      path: target,
      branch: 'dirty',
      force: false,
    })

    expect(removal.worktreeRemoved.ok).toBe(false)
    expect(removal.branchDeleted).toBeUndefined()
    const listing = await listWorktrees({ cwd: root })
    expect(listing.ok && listing.worktrees).toHaveLength(2)
  })

  it('removes a dirty worktree and deletes its branch when forced', async () => {
    const root = await repoWithCommit()
    const target = join(await scratch(), 'forced')
    await addWorktree({ cwd: root, path: target, branch: 'forced', base: 'main' })
    await Bun.write(join(target, 'unsaved.txt'), 'wip')

    const removal = await removeWorktree({ cwd: root, path: target, branch: 'forced', force: true })

    expect(removal.worktreeRemoved.ok).toBe(true)
    expect(removal.branchDeleted?.ok).toBe(true)
    const listing = await listWorktrees({ cwd: root })
    expect(listing.ok && listing.worktrees).toHaveLength(1)
  })

  it('reports the branch step separately when the branch will not delete', async () => {
    const root = await repoWithCommit()
    const target = join(await scratch(), 'ghost')
    await addWorktree({ cwd: root, path: target, branch: 'ghost', base: 'main' })

    const removal = await removeWorktree({
      cwd: root,
      path: target,
      branch: 'never-existed',
      force: false,
    })

    expect(removal.worktreeRemoved.ok).toBe(true)
    expect(removal.branchDeleted?.ok).toBe(false)
  })
})

describe('pruneWorktrees', () => {
  it('succeeds on a repo whose linked worktree directory is gone', async () => {
    const root = await repoWithCommit()
    const target = join(await scratch(), 'vanished')
    await addWorktree({ cwd: root, path: target, branch: 'vanished', base: 'main' })
    await rm(target, { recursive: true, force: true })

    expect(await pruneWorktrees({ cwd: root })).toEqual({ ok: true })
    const listing = await listWorktrees({ cwd: root })
    expect(listing.ok && listing.worktrees).toHaveLength(1)
  })
})
