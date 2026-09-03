import { afterAll, describe, expect, it } from 'bun:test'
import { mkdir, mkdtemp, rm, realpath, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  EWorktreeExit,
  enteredWorktreeOf,
  exitedWorktreeOf,
  toThreadId,
  worktreeLockToken,
  type ActiveWorktree,
} from '@dltech/atlas-core'


import { ownIdentity } from '../../../workspace/process-identity'
import { listWorktrees, lockWorktree } from '../../../workspace/worktrees'
import { EnterWorktreeTool } from '../enter-worktree'
import { ExitWorktreeTool } from '../exit-worktree'
import { WorktreeListTool } from '../worktree-list'

const WORKTREE_DIRECTORY = '.atlas/worktrees'

const made: string[] = []

const scratch = async (): Promise<string> => {
  const path = await realpath(await mkdtemp(join(tmpdir(), 'atlas-worktree-tools-')))
  made.push(path)
  return path
}

const git = async (args: readonly string[], cwd: string): Promise<void> => {
  const proc = Bun.spawn(['git', ...args], { cwd, stdout: 'ignore', stderr: 'ignore' })
  if ((await proc.exited) !== 0) throw new Error(`git ${args.join(' ')} failed in ${cwd}`)
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

const toolsFor = (launchDirectory: string) => ({
  enter: new EnterWorktreeTool(launchDirectory, () => WORKTREE_DIRECTORY),
  exit: new ExitWorktreeTool(launchDirectory),
  list: new WorktreeListTool(),
})

const invocation = (args: {
  input: unknown
  projectDirectory: string
  homeDirectory?: string
  activeWorktree?: ActiveWorktree
}) => ({
  input: args.input,
  signal: new AbortController().signal,
  idempotencyKey: 'run:call',
  projectDirectory: args.projectDirectory,
  homeDirectory: args.homeDirectory,
  activeWorktree: args.activeWorktree,
  threadId: toThreadId('thread-1'),
})

const exists = async (path: string): Promise<boolean> => {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

afterAll(async () => {
  await Promise.all(made.map((path) => rm(path, { recursive: true, force: true })))
})

describe('entering a worktree', () => {
  it('creates it under the configured directory and reports the move', async () => {
    const root = await repoWithCommit()
    const { enter } = toolsFor(root)

    const outcome = await enter.invoke(invocation({ input: { name: 'eng-327' }, projectDirectory: root }))

    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return

    const entered = enteredWorktreeOf(outcome.output)
    expect(entered?.path).toBe(join(root, WORKTREE_DIRECTORY, 'eng-327'))
    expect(entered?.branch).toBe('eng-327')
    expect(await exists(join(root, WORKTREE_DIRECTORY, 'eng-327', 'README.md'))).toBe(true)
  })

  it('hides the worktree home from git, so the checkouts never show as untracked', async () => {
    const root = await repoWithCommit()
    const { enter } = toolsFor(root)

    await enter.invoke(invocation({ input: { name: 'eng-327' }, projectDirectory: root }))

    const status = Bun.spawn(['git', 'status', '--porcelain'], { cwd: root, stdout: 'pipe' })
    const [text] = await Promise.all([new Response(status.stdout).text(), status.exited])

    expect(text.trim()).toBe('')
  })

  it('refuses a name and a path together, and refuses neither', async () => {
    const root = await repoWithCommit()
    const { enter } = toolsFor(root)

    const both = await enter.invoke(invocation({ input: { name: 'a', path: '/tmp/b' }, projectDirectory: root }))
    const neither = await enter.invoke(invocation({ input: {}, projectDirectory: root }))

    expect(both.ok).toBe(false)
    expect(neither.ok).toBe(false)
  })

  it('refuses a name that would not make a usable directory or branch', async () => {
    const root = await repoWithCommit()
    const { enter } = toolsFor(root)

    const outcome = await enter.invoke(invocation({ input: { name: '../escape' }, projectDirectory: root }))

    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.reason).toContain('not a usable worktree name')
  })

  it('refuses to create a second worktree while the session is already in one', async () => {
    const root = await repoWithCommit()
    const { enter } = toolsFor(root)

    const first = await enter.invoke(invocation({ input: { name: 'eng-327' }, projectDirectory: root }))
    expect(first.ok).toBe(true)
    if (!first.ok) return

    const inside = enteredWorktreeOf(first.output)?.path ?? root
    const second = await enter.invoke(
      invocation({
        input: { name: 'eng-401' },
        projectDirectory: inside,
        activeWorktree: { path: inside, branch: 'eng-327', base: 'main', adopted: false },
      }),
    )

    expect(second.ok).toBe(false)
    if (second.ok) return
    expect(second.reason).toContain('already in the worktree')
  })

  it('switches straight into another worktree by path, even from inside one', async () => {
    const root = await repoWithCommit()
    const { enter } = toolsFor(root)

    const first = await enter.invoke(invocation({ input: { name: 'eng-327' }, projectDirectory: root }))
    expect(first.ok).toBe(true)
    if (!first.ok) return
    const inside = enteredWorktreeOf(first.output)?.path ?? root

    await git(['worktree', 'add', join(root, 'elsewhere'), '-b', 'by-hand'], root)

    const switched = await enter.invoke(
      invocation({ input: { path: join(root, 'elsewhere') }, projectDirectory: inside }),
    )

    expect(switched.ok).toBe(true)
    if (!switched.ok) return
    expect(enteredWorktreeOf(switched.output)?.branch).toBe('by-hand')
  })

  it('refuses a path git does not list as a worktree of this repository', async () => {
    const root = await repoWithCommit()
    const stranger = await scratch()
    const { enter } = toolsFor(root)

    const outcome = await enter.invoke(invocation({ input: { path: stranger }, projectDirectory: root }))

    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.reason).toContain('does not list')
  })
})

describe('leaving a worktree', () => {
  const entered = async (root: string): Promise<ActiveWorktree> => {
    const { enter } = toolsFor(root)
    const outcome = await enter.invoke(invocation({ input: { name: 'eng-327' }, projectDirectory: root }))
    if (!outcome.ok) throw new Error('could not enter')
    const entry = enteredWorktreeOf(outcome.output)
    if (entry === undefined) throw new Error('enter reported no worktree')
    return {
      path: entry.path,
      branch: entry.branch,
      base: entry.base,
      adopted: entry.adopted === true,
    }
  }

  it('does nothing at all when the session is not in a worktree', async () => {
    const root = await repoWithCommit()
    const { exit } = toolsFor(root)

    const outcome = await exit.invoke(
      invocation({ input: { action: EWorktreeExit.Remove }, projectDirectory: root }),
    )

    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect(exitedWorktreeOf(outcome.output)).toBeUndefined()
    expect(outcome.modelText).toContain('not in a worktree')
  })

  it('keeps the worktree on disk when asked to keep it', async () => {
    const root = await repoWithCommit()
    const inside = await entered(root)
    const { exit } = toolsFor(root)

    const outcome = await exit.invoke(
      invocation({
        input: { action: EWorktreeExit.Keep },
        projectDirectory: inside.path,
        activeWorktree: inside,
      }),
    )

    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect(exitedWorktreeOf(outcome.output)).toEqual({
      path: inside.path,
      action: EWorktreeExit.Keep,
      returnTo: root,
    })
    expect(await exists(inside.path)).toBe(true)
  })

  it('removes a clean worktree and its branch', async () => {
    const root = await repoWithCommit()
    const inside = await entered(root)
    const { exit } = toolsFor(root)

    const outcome = await exit.invoke(
      invocation({
        input: { action: EWorktreeExit.Remove },
        projectDirectory: inside.path,
        activeWorktree: inside,
      }),
    )

    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect(exitedWorktreeOf(outcome.output)?.action).toBe(EWorktreeExit.Remove)
    expect(await exists(inside.path)).toBe(false)
  })

  it('refuses to remove a worktree holding uncommitted work, and names what would be lost', async () => {
    const root = await repoWithCommit()
    const inside = await entered(root)
    await Bun.write(join(inside.path, 'notes.md'), 'work in progress')
    const { exit } = toolsFor(root)

    const outcome = await exit.invoke(
      invocation({
        input: { action: EWorktreeExit.Remove },
        projectDirectory: inside.path,
        activeWorktree: inside,
      }),
    )

    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.reason).toContain('notes.md')
    expect(outcome.reason).toContain('discardChanges')
    expect(await exists(inside.path)).toBe(true)
  })

  it('removes it anyway once discardChanges says so', async () => {
    const root = await repoWithCommit()
    const inside = await entered(root)
    await Bun.write(join(inside.path, 'notes.md'), 'work in progress')
    const { exit } = toolsFor(root)

    const outcome = await exit.invoke(
      invocation({
        input: { action: EWorktreeExit.Remove, discardChanges: true },
        projectDirectory: inside.path,
        activeWorktree: inside,
      }),
    )

    expect(outcome.ok).toBe(true)
    expect(await exists(inside.path)).toBe(false)
  })
})

describe('leaving a worktree the session was launched inside', () => {
  const repoWithWorktree = async (): Promise<{ root: string; tree: string }> => {
    const root = await repoWithCommit()
    const tree = join(root, 'launched-here')
    await git(['worktree', 'add', '-b', 'launched', tree], root)
    return { root, tree }
  }

  it('moves the session to the main checkout and keeps the worktree', async () => {
    const { root, tree } = await repoWithWorktree()
    const { exit } = toolsFor(tree)

    const outcome = await exit.invoke(
      invocation({ input: { action: EWorktreeExit.Keep }, projectDirectory: tree }),
    )

    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect(exitedWorktreeOf(outcome.output)).toEqual({
      path: tree,
      action: EWorktreeExit.Keep,
      returnTo: root,
    })
    expect(outcome.modelText).toContain('main checkout')
    expect(await exists(tree)).toBe(true)
  })

  it('releases the lock the session took at launch', async () => {
    const { root, tree } = await repoWithWorktree()
    await lockWorktree({
      cwd: root,
      path: tree,
      reason: worktreeLockToken({ label: 'session', identity: await ownIdentity() }),
    })
    const { exit } = toolsFor(tree)

    const outcome = await exit.invoke(
      invocation({ input: { action: EWorktreeExit.Keep }, projectDirectory: tree }),
    )

    expect(outcome.ok).toBe(true)

    const listing = await listWorktrees({ cwd: root })
    const found = listing.ok ? listing.worktrees.find((worktree) => worktree.path === tree) : undefined
    expect(found?.isLocked).toBe(false)
  })

  it('never removes it, whichever action is asked for', async () => {
    const { root, tree } = await repoWithWorktree()
    const { exit } = toolsFor(tree)

    const outcome = await exit.invoke(
      invocation({ input: { action: EWorktreeExit.Remove }, projectDirectory: tree }),
    )

    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect(exitedWorktreeOf(outcome.output)).toEqual({
      path: tree,
      action: EWorktreeExit.Keep,
      returnTo: root,
    })
    expect(outcome.modelText).toContain('did not create it')
    expect(await exists(tree)).toBe(true)
  })

  it('finds the worktree when the launch directory is a subdirectory of it', async () => {
    const { root, tree } = await repoWithWorktree()
    const nested = join(tree, 'packages', 'core')
    await mkdir(nested, { recursive: true })
    const { exit } = toolsFor(nested)

    const outcome = await exit.invoke(
      invocation({ input: { action: EWorktreeExit.Keep }, projectDirectory: nested }),
    )

    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect(exitedWorktreeOf(outcome.output)).toEqual({
      path: tree,
      action: EWorktreeExit.Keep,
      returnTo: root,
    })
  })

  it('does nothing once the session has already landed on the main checkout', async () => {
    const { root, tree } = await repoWithWorktree()
    const { exit } = toolsFor(tree)

    const outcome = await exit.invoke(
      invocation({
        input: { action: EWorktreeExit.Keep },
        projectDirectory: root,
        homeDirectory: root,
      }),
    )

    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect(exitedWorktreeOf(outcome.output)).toBeUndefined()
    expect(outcome.modelText).toContain('not in a worktree')
  })
})

describe('listing worktrees', () => {
  it('names the main checkout and marks where the session is', async () => {
    const root = await repoWithCommit()
    const { enter, list } = toolsFor(root)

    const created = await enter.invoke(invocation({ input: { name: 'eng-327' }, projectDirectory: root }))
    expect(created.ok).toBe(true)
    if (!created.ok) return
    const inside = enteredWorktreeOf(created.output)?.path ?? root

    const outcome = await list.invoke(invocation({ input: {}, projectDirectory: inside }))

    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect(outcome.modelText).toContain('main checkout')
    expect(outcome.modelText).toContain('this session')
    expect(outcome.modelText).toContain('eng-327')
  })
})
