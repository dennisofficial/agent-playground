import { afterAll, describe, expect, it } from 'bun:test'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { parseWorktreeLockToken, worktreeLockToken } from '@dltech/atlas-core'

import { startTimeOf } from '../process-identity'
import { listWorktrees, lockWorktree } from '../worktrees'
import { claimWorktreeAt, EWorktreeClaim } from '../worktree-lock'

const made: string[] = []

const scratch = async (): Promise<string> => {
  const path = await realpath(await mkdtemp(join(tmpdir(), 'atlas-claim-at-')))
  made.push(path)
  return path
}

const git = async (args: readonly string[], cwd: string): Promise<void> => {
  const proc = Bun.spawn(['git', ...args], { cwd, stdout: 'ignore', stderr: 'ignore' })
  if ((await proc.exited) !== 0) throw new Error(`git ${args.join(' ')} failed in ${cwd}`)
}

const repo = async (): Promise<string> => {
  const root = await scratch()
  await git(['init', '-b', 'main'], root)
  await git(['config', 'user.email', 'test@example.com'], root)
  await git(['config', 'user.name', 'Test'], root)
  await Bun.write(join(root, 'README.md'), 'hello')
  await git(['add', '.'], root)
  await git(['commit', '-m', 'initial'], root)
  return root
}

const byHand = async ({ root, name, branch }: { root: string; name: string; branch: string }) => {
  const tree = join(root, name)
  await git(['worktree', 'add', '-b', branch, tree], root)
  return tree
}

const lockOf = async ({ root, path }: { root: string; path: string }) => {
  const listing = await listWorktrees({ cwd: root })
  if (!listing.ok) throw new Error('could not list worktrees')
  const found = listing.worktrees.find((worktree) => worktree.path === path)
  return { isLocked: found?.isLocked ?? false, reason: found?.lockedReason }
}

afterAll(async () => {
  await Promise.all(made.map((path) => rm(path, { recursive: true, force: true })))
})

describe('claiming the worktree a reopened thread is sitting in', () => {
  it('claims an unlocked worktree, naming this process in the reason', async () => {
    const root = await repo()
    const tree = await byHand({ root, name: 'quiet', branch: 'topic' })

    const claimed = await claimWorktreeAt({ cwd: tree, label: 'thread br_1' })

    expect(claimed?.outcome.claim).toBe(EWorktreeClaim.Owned)
    expect(claimed?.path).toBe(tree)
    expect(parseWorktreeLockToken((await lockOf({ root, path: tree })).reason ?? '')?.pid).toBe(
      process.pid,
    )
  })

  it('reclaims a lock left behind by an Atlas session that is gone', async () => {
    const root = await repo()
    const tree = await byHand({ root, name: 'abandoned', branch: 'crashed' })
    await lockWorktree({
      cwd: root,
      path: tree,
      reason: worktreeLockToken({
        label: 'thread br_dead',
        identity: { pid: 2, start: 'Mon Sep  1 00:00:00 1999' },
      }),
    })

    const claimed = await claimWorktreeAt({ cwd: tree, label: 'thread br_1' })

    expect(claimed?.outcome.claim).toBe(EWorktreeClaim.Reclaimed)
    expect(parseWorktreeLockToken((await lockOf({ root, path: tree })).reason ?? '')?.pid).toBe(
      process.pid,
    )
  })

  it('leaves a lock a live session holds alone, and says who holds it', async () => {
    const root = await repo()
    const tree = await byHand({ root, name: 'taken', branch: 'theirs' })
    const other = Bun.spawn(['sleep', '30'], { stdout: 'ignore', stderr: 'ignore' })
    try {
      const reason = worktreeLockToken({
        label: 'thread br_other',
        identity: { pid: other.pid, start: await startTimeOf({ pid: other.pid }) },
      })
      await lockWorktree({ cwd: root, path: tree, reason })

      const claimed = await claimWorktreeAt({ cwd: tree, label: 'thread br_1' })

      expect(claimed?.outcome.claim).toBe(EWorktreeClaim.Held)
      expect(claimed?.outcome.heldBy).toBe(other.pid)
      expect((await lockOf({ root, path: tree })).reason).toBe(reason)
    } finally {
      other.kill()
      await other.exited
    }
  })

  it('does nothing in the main checkout, which needs no lock', async () => {
    const root = await repo()

    const claimed = await claimWorktreeAt({ cwd: root, label: 'thread br_1' })

    expect(claimed).toBeUndefined()
    expect((await lockOf({ root, path: root })).isLocked).toBe(false)
  })

  it('does nothing outside a repository', async () => {
    const bare = await scratch()

    expect(await claimWorktreeAt({ cwd: bare, label: 'thread br_1' })).toBeUndefined()
  })
})
