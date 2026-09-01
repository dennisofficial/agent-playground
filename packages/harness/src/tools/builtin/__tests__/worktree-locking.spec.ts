import { afterAll, describe, expect, it } from 'bun:test'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  EWorktreeExit,
  enteredWorktreeOf,
  parseWorktreeLockToken,
  toThreadId,
  worktreeLockToken,
  type ActiveWorktree,
} from '@dltech/atlas-core'

import { createIsolatedContainer } from '../../../container/injection'
import { WorkspaceRoot, WorktreeDirectoryToken } from '../../../container/tokens'
import { startTimeOf } from '../../../workspace/process-identity'
import { listWorktrees, lockWorktree } from '../../../workspace/worktrees'
import { EnterWorktreeTool } from '../enter-worktree'
import { ExitWorktreeTool } from '../exit-worktree'

const made: string[] = []

const scratch = async (): Promise<string> => {
  const path = await realpath(await mkdtemp(join(tmpdir(), 'atlas-worktree-lock-')))
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

const toolsFor = (launchDirectory: string) => {
  const container = createIsolatedContainer()
  container.register(WorkspaceRoot, { useValue: launchDirectory })
  container.register(WorktreeDirectoryToken, { useValue: () => '.atlas/worktrees' })

  return {
    enter: container.resolve(EnterWorktreeTool),
    exit: container.resolve(ExitWorktreeTool),
  }
}

const invocation = (args: {
  input: unknown
  projectDirectory: string
  activeWorktree?: ActiveWorktree
}) => ({
  input: args.input,
  signal: new AbortController().signal,
  idempotencyKey: 'run:call',
  projectDirectory: args.projectDirectory,
  ...(args.activeWorktree === undefined ? {} : { activeWorktree: args.activeWorktree }),
  threadId: toThreadId('br_7'),
})

const lockOf = async ({ root, path }: { root: string; path: string }) => {
  const listing = await listWorktrees({ cwd: root })
  if (!listing.ok) throw new Error('could not list worktrees')
  const found = listing.worktrees.find((worktree) => worktree.path === path)
  return { isLocked: found?.isLocked ?? false, reason: found?.lockedReason }
}

const byHand = async ({ root, name, branch }: { root: string; name: string; branch: string }) => {
  const tree = join(root, name)
  await git(['worktree', 'add', '-b', branch, tree], root)
  return tree
}

const reasonOf = (outcome: { ok: boolean; reason?: string }): string => outcome.reason ?? ''

afterAll(async () => {
  await Promise.all(made.map((path) => rm(path, { recursive: true, force: true })))
})

describe('claiming a worktree so two sessions cannot share it', () => {
  it('locks a worktree it creates, naming this process in the reason', async () => {
    const root = await repo()
    const { enter } = toolsFor(root)

    const outcome = await enter.invoke(
      invocation({ input: { name: 'eng-327' }, projectDirectory: root }),
    )
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return

    const tree = enteredWorktreeOf(outcome.output)?.path ?? root
    const lock = await lockOf({ root, path: tree })

    expect(lock.isLocked).toBe(true)
    expect(parseWorktreeLockToken(lock.reason ?? '')?.pid).toBe(process.pid)
  })

  it('locks a worktree it adopts, which is where two sessions actually collide', async () => {
    const root = await repo()
    const tree = await byHand({ root, name: 'shared', branch: 'topic' })
    const { enter } = toolsFor(root)

    expect(
      (await enter.invoke(invocation({ input: { path: tree }, projectDirectory: root }))).ok,
    ).toBe(true)
    expect(parseWorktreeLockToken((await lockOf({ root, path: tree })).reason ?? '')?.pid).toBe(
      process.pid,
    )
  })

  it('refuses a worktree another live process holds, and takes it once that process dies', async () => {
    const root = await repo()
    const tree = await byHand({ root, name: 'taken', branch: 'theirs' })

    const other = Bun.spawn(['sleep', '30'], { stdout: 'ignore', stderr: 'ignore' })
    await lockWorktree({
      cwd: root,
      path: tree,
      reason: worktreeLockToken({
        label: 'thread br_other',
        identity: { pid: other.pid, start: await startTimeOf({ pid: other.pid }) },
      }),
    })

    const { enter } = toolsFor(root)
    const refused = await enter.invoke(
      invocation({ input: { path: tree }, projectDirectory: root }),
    )

    expect(refused.ok).toBe(false)
    expect(reasonOf(refused)).toContain('another Atlas session is working in it')

    other.kill()
    await other.exited

    const taken = await enter.invoke(invocation({ input: { path: tree }, projectDirectory: root }))

    expect(taken.ok).toBe(true)
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

    const { enter } = toolsFor(root)
    const outcome = await enter.invoke(
      invocation({ input: { path: tree }, projectDirectory: root }),
    )

    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return

    expect(outcome.modelText).toContain('no longer running')
    expect(parseWorktreeLockToken((await lockOf({ root, path: tree })).reason ?? '')?.pid).toBe(
      process.pid,
    )
  })

  it('leaves a lock a person set themselves alone, and works in it as a guest', async () => {
    const root = await repo()
    const tree = await byHand({ root, name: 'held-by-hand', branch: 'careful' })
    await lockWorktree({ cwd: root, path: tree, reason: 'holding this for the release' })

    const { enter } = toolsFor(root)
    const outcome = await enter.invoke(
      invocation({ input: { path: tree }, projectDirectory: root }),
    )

    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return

    expect(outcome.modelText).toContain('guest')
    expect((await lockOf({ root, path: tree })).reason).toBe('holding this for the release')
  })
})

describe('giving the worktree back', () => {
  it('unlocks it on the way out, so another session can take it', async () => {
    const root = await repo()
    const tree = await byHand({ root, name: 'borrowed', branch: 'topic' })
    const { enter, exit } = toolsFor(root)

    await enter.invoke(invocation({ input: { path: tree }, projectDirectory: root }))
    expect((await lockOf({ root, path: tree })).isLocked).toBe(true)

    const outcome = await exit.invoke(
      invocation({
        input: { action: EWorktreeExit.Keep },
        projectDirectory: tree,
        activeWorktree: { path: tree, branch: 'topic', base: undefined, adopted: true },
      }),
    )

    expect(outcome.ok).toBe(true)
    expect((await lockOf({ root, path: tree })).isLocked).toBe(false)
  })

  it('drops its own lock when switching straight to another worktree', async () => {
    const root = await repo()
    const first = await byHand({ root, name: 'one', branch: 'first' })
    const second = await byHand({ root, name: 'two', branch: 'second' })
    const { enter } = toolsFor(root)

    await enter.invoke(invocation({ input: { path: first }, projectDirectory: root }))
    await enter.invoke(invocation({ input: { path: second }, projectDirectory: first }))

    expect((await lockOf({ root, path: first })).isLocked).toBe(false)
    expect((await lockOf({ root, path: second })).isLocked).toBe(true)
  })
})
