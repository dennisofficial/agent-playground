import { afterAll, describe, expect, it } from 'bun:test'
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { EWorktreeExit, enteredWorktreeOf, exitedWorktreeOf, toThreadId } from '@dltech/atlas-core'


import { EnterWorktreeTool } from '../enter-worktree'
import { ExitWorktreeTool } from '../exit-worktree'

const WORKTREE_DIRECTORY = '.atlas/worktrees'

const made: string[] = []

const scratch = async (): Promise<string> => {
  const path = await realpath(await mkdtemp(join(tmpdir(), 'atlas-worktree-adopt-')))
  made.push(path)
  return path
}

const git = async (args: readonly string[], cwd: string): Promise<void> => {
  const proc = Bun.spawn(['git', ...args], { cwd, stdout: 'ignore', stderr: 'ignore' })
  if ((await proc.exited) !== 0) throw new Error(`git ${args.join(' ')} failed in ${cwd}`)
}

const repoWithOrigin = async (): Promise<string> => {
  const origin = await scratch()
  await git(['init', '--bare', '-b', 'main'], origin)

  const root = await scratch()
  await git(['init', '-b', 'main'], root)
  await git(['config', 'user.email', 'test@example.com'], root)
  await git(['config', 'user.name', 'Test'], root)
  await Bun.write(join(root, 'README.md'), 'hello')
  await git(['add', '.'], root)
  await git(['commit', '-m', 'initial'], root)
  await git(['remote', 'add', 'origin', origin], root)
  await git(['push', '-u', 'origin', 'main'], root)
  return root
}

const repoWithoutOrigin = async (): Promise<string> => {
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
})

const invocation = (args: {
  input: unknown
  projectDirectory: string
  activeWorktree?: { path: string; branch: string; base: string | undefined; adopted: boolean }
}) => ({
  input: args.input,
  signal: new AbortController().signal,
  idempotencyKey: 'run:call',
  projectDirectory: args.projectDirectory,
  ...(args.activeWorktree === undefined ? {} : { activeWorktree: args.activeWorktree }),
  threadId: toThreadId('thread-1'),
})

const reasonOf = (outcome: { ok: boolean; reason?: string }): string => outcome.reason ?? ''

afterAll(async () => {
  await Promise.all(made.map((path) => rm(path, { recursive: true, force: true })))
})

describe('adopting a worktree the session did not create', () => {
  it('reports the branch, its upstream and what is uncommitted there', async () => {
    const root = await repoWithOrigin()
    const tree = join(root, 'by-hand')
    await git(['worktree', 'add', '-b', 'topic', tree], root)
    await git(['push', '-u', 'origin', 'topic'], tree)
    await Bun.write(join(tree, 'draft.txt'), 'work in progress')

    const { enter } = toolsFor(root)
    const outcome = await enter.invoke(
      invocation({ input: { path: tree }, projectDirectory: root }),
    )

    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return

    expect(enteredWorktreeOf(outcome.output)).toEqual({
      path: tree,
      branch: 'topic',
      base: 'origin/topic',
      adopted: true,
    })
    expect(outcome.modelText).toContain('It tracks origin/topic.')
    expect(outcome.modelText).toContain('1 uncommitted file')
    expect(outcome.modelText).toContain('Atlas did not create this worktree')
  })

  it('says a worktree with no upstream has none, rather than inventing a base', async () => {
    const root = await repoWithOrigin()
    const tree = join(root, 'unpushed')
    await git(['worktree', 'add', '-b', 'lonely', tree], root)

    const { enter } = toolsFor(root)
    const outcome = await enter.invoke(
      invocation({ input: { path: tree }, projectDirectory: root }),
    )

    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return

    expect(enteredWorktreeOf(outcome.output)).toEqual({
      path: tree,
      branch: 'lonely',
      adopted: true,
    })
    expect(outcome.modelText).toContain('It has no upstream.')
  })

  it('hides the worktree home when the adopted worktree lives inside it', async () => {
    const root = await repoWithOrigin()
    const tree = join(root, WORKTREE_DIRECTORY, 'eng-401')
    await git(['worktree', 'add', '-b', 'eng-401', tree], root)

    const { enter } = toolsFor(root)
    const outcome = await enter.invoke(
      invocation({ input: { path: tree }, projectDirectory: root }),
    )

    expect(outcome.ok).toBe(true)
    expect(await readFile(join(root, WORKTREE_DIRECTORY, '.gitignore'), 'utf8')).toBe('*\n')
  })

  it('refuses the repository main checkout, which is not a worktree to enter', async () => {
    const root = await repoWithOrigin()
    const { enter } = toolsFor(root)

    const outcome = await enter.invoke(
      invocation({ input: { path: root }, projectDirectory: root }),
    )

    expect(outcome.ok).toBe(false)
    expect(reasonOf(outcome)).toContain('is the main checkout of the repository')
  })

  it('refuses a detached HEAD, which has no branch to work on', async () => {
    const root = await repoWithOrigin()
    const tree = join(root, 'loose')
    await git(['worktree', 'add', '--detach', tree, 'HEAD'], root)

    const { enter } = toolsFor(root)
    const outcome = await enter.invoke(
      invocation({ input: { path: tree }, projectDirectory: root }),
    )

    expect(outcome.ok).toBe(false)
    expect(reasonOf(outcome)).toContain('detached HEAD')
  })

  it('refuses a worktree git has already marked prunable', async () => {
    const root = await repoWithOrigin()
    const tree = join(root, 'gone')
    await git(['worktree', 'add', '-b', 'ghost', tree], root)
    await rm(tree, { recursive: true, force: true })

    const { enter } = toolsFor(root)
    const outcome = await enter.invoke(
      invocation({ input: { path: tree }, projectDirectory: root }),
    )

    expect(outcome.ok).toBe(false)
    expect(reasonOf(outcome)).toContain('prunable')
  })

  it('changes nothing when the session is already standing in that worktree', async () => {
    const root = await repoWithOrigin()
    const tree = join(root, 'already')
    await git(['worktree', 'add', '-b', 'here', tree], root)

    const { enter } = toolsFor(root)
    const outcome = await enter.invoke(
      invocation({ input: { path: tree }, projectDirectory: tree }),
    )

    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return

    expect(enteredWorktreeOf(outcome.output)).toBeUndefined()
    expect(outcome.modelText).toContain('already in the worktree')
  })
})

describe('leaving a worktree the session adopted', () => {
  const adopted = (path: string) => ({ path, branch: 'topic', base: undefined, adopted: true })

  it('keeps it on disk even when asked to remove it', async () => {
    const root = await repoWithOrigin()
    const tree = join(root, 'borrowed')
    await git(['worktree', 'add', '-b', 'topic', tree], root)

    const { exit } = toolsFor(root)
    const outcome = await exit.invoke(
      invocation({
        input: { action: EWorktreeExit.Remove },
        projectDirectory: tree,
        activeWorktree: adopted(tree),
      }),
    )

    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return

    expect(exitedWorktreeOf(outcome.output)).toEqual({ path: tree, action: EWorktreeExit.Keep })
    expect(outcome.modelText).toContain('Atlas did not create it')
    expect(await Bun.file(join(tree, 'README.md')).exists()).toBe(true)
  })

  it('counts commits against the ref the branch was cut from when there is no upstream to compare with', async () => {
    const root = await repoWithoutOrigin()
    const { enter, exit } = toolsFor(root)

    const created = await enter.invoke(
      invocation({ input: { name: 'eng-327' }, projectDirectory: root }),
    )
    expect(created.ok).toBe(true)
    if (!created.ok) return

    const entry = enteredWorktreeOf(created.output)
    expect(entry?.base).toBe('main')

    const tree = entry?.path ?? root
    await Bun.write(join(tree, 'feature.ts'), 'export const x = 1')
    await git(['add', '.'], tree)
    await git(['commit', '-m', 'work worth not losing'], tree)

    const outcome = await exit.invoke(
      invocation({
        input: { action: EWorktreeExit.Remove },
        projectDirectory: tree,
        activeWorktree: { path: tree, branch: 'eng-327', base: entry?.base, adopted: false },
      }),
    )

    expect(outcome.ok).toBe(false)
    expect(reasonOf(outcome)).toContain('1 commit not on main')
    expect(await Bun.file(join(tree, 'feature.ts')).exists()).toBe(true)
  })

  it('still removes one the session created itself', async () => {
    const root = await repoWithOrigin()
    const { enter, exit } = toolsFor(root)

    const created = await enter.invoke(
      invocation({ input: { name: 'eng-327' }, projectDirectory: root }),
    )
    expect(created.ok).toBe(true)
    if (!created.ok) return

    const tree = enteredWorktreeOf(created.output)?.path ?? root
    const outcome = await exit.invoke(
      invocation({
        input: { action: EWorktreeExit.Remove },
        projectDirectory: tree,
        activeWorktree: { path: tree, branch: 'eng-327', base: 'origin/main', adopted: false },
      }),
    )

    expect(outcome.ok).toBe(true)
    expect(await Bun.file(join(tree, 'README.md')).exists()).toBe(false)
  })
})
