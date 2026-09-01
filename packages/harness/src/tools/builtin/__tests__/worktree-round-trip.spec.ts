import { afterAll, describe, expect, it } from 'bun:test'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  EToolEffect,
  EWorktreeExit,
  activeWorktreeOf,
  projectDirectoryOf,
  stampDrafts,
  toCallId,
  toEventId,
  toRunId,
  toThreadId,
  type Event,
  type EventDraft,
  type ToolCall,
} from '@dltech/atlas-core'

import { createIsolatedContainer } from '../../../container/injection'
import { WorkspaceRoot, WorktreeDirectoryToken } from '../../../container/tokens'
import { TrackWorktreeHook } from '../../../hooks/track-worktree'
import { EnterWorktreeTool } from '../enter-worktree'
import { ExitWorktreeTool } from '../exit-worktree'

const made: string[] = []

const git = async (args: readonly string[], cwd: string): Promise<void> => {
  const proc = Bun.spawn(['git', ...args], { cwd, stdout: 'ignore', stderr: 'ignore' })
  if ((await proc.exited) !== 0) throw new Error(`git ${args.join(' ')} failed`)
}

const repoWithCommit = async (): Promise<string> => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'atlas-worktree-round-trip-')))
  made.push(root)
  await git(['init', '-b', 'main'], root)
  await git(['config', 'user.email', 'test@example.com'], root)
  await git(['config', 'user.name', 'Test'], root)
  await Bun.write(join(root, 'README.md'), 'hello')
  await git(['add', '.'], root)
  await git(['commit', '-m', 'initial'], root)
  return root
}

const call = (name: string): ToolCall => ({
  callId: toCallId('call-1'),
  name,
  input: {},
  effect: EToolEffect.Destructive,
  threadId: toThreadId('thread-1'),
})

const log = (drafts: readonly EventDraft[]): Event[] =>
  stampDrafts({
    drafts,
    envelopes: drafts.map((_draft, index) => ({
      id: toEventId(`event-${index + 1}`),
      seq: index + 1,
      threadId: toThreadId('thread-1'),
      runId: toRunId('run-1'),
      depth: 0,
      at: '2026-08-31T00:00:00.000Z',
    })),
  })

afterAll(async () => {
  await Promise.all(made.map((path) => rm(path, { recursive: true, force: true })))
})

describe('a worktree the whole way round', () => {
  it('moves the project and session directory in, and back out again', async () => {
    const root = await repoWithCommit()

    const container = createIsolatedContainer()
    container.register(WorkspaceRoot, { useValue: root })
    container.register(WorktreeDirectoryToken, { useValue: () => '.atlas/worktrees' })

    const enter = container.resolve(EnterWorktreeTool)
    const exit = container.resolve(ExitWorktreeTool)
    const hook = new TrackWorktreeHook()

    const invocation = (input: unknown, projectDirectory: string) => ({
      input,
      signal: new AbortController().signal,
      idempotencyKey: 'run:call',
      projectDirectory,
      threadId: toThreadId('thread-1'),
    })

    const entering = await enter.invoke(invocation({ name: 'eng-327' }, root))
    expect(entering.ok).toBe(true)
    if (!entering.ok) return

    const enteredDrafts =
      (await hook.run({ call: call('enter_worktree'), result: entering })).drafts ?? []
    const afterEnter = log([{ type: 'user-said', text: 'go' }, ...enteredDrafts])

    const tree = join(root, '.atlas/worktrees/eng-327')
    expect(projectDirectoryOf({ events: afterEnter, launchDirectory: root })).toBe(tree)
    expect(projectDirectoryOf({ events: afterEnter, launchDirectory: root })).toBe(tree)
    expect(activeWorktreeOf(afterEnter)?.branch).toBe('eng-327')

    const leaving = await exit.invoke(invocation({ action: EWorktreeExit.Keep }, tree))
    expect(leaving.ok).toBe(true)
    if (!leaving.ok) return

    const exitedDrafts =
      (await hook.run({ call: call('exit_worktree'), result: leaving })).drafts ?? []
    const afterExit = log([...enteredDrafts, ...exitedDrafts])

    expect(projectDirectoryOf({ events: afterExit, launchDirectory: root })).toBe(root)
    expect(projectDirectoryOf({ events: afterExit, launchDirectory: root })).toBe(root)
    expect(activeWorktreeOf(afterExit)).toBeUndefined()
  })
})
