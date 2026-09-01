import { describe, expect, it } from 'bun:test'

import {
  EToolEffect,
  EWorktreeExit,
  toCallId,
  toThreadId,
  type EventDraft,
  type ToolCall,
  type ToolOutcome,
} from '@dltech/atlas-core'

import { TrackWorktreeHook } from '../track-worktree'

const TREE = '/Users/dev/project/.atlas/worktrees/eng-327'

const call: ToolCall = {
  callId: toCallId('call-1'),
  name: 'enter_worktree',
  input: {},
  effect: EToolEffect.Destructive,
  threadId: toThreadId('thread-fixture'),
}

const succeeded = (output: unknown): ToolOutcome => ({ ok: true, output, modelText: 'done' })

const draftsFor = async (result: ToolOutcome): Promise<readonly EventDraft[]> =>
  (await new TrackWorktreeHook().run({ call, result })).drafts ?? []

describe('what the hook records about worktrees', () => {
  it('records nothing when the tool moved no worktree', async () => {
    expect(await draftsFor(succeeded({ exited: false }))).toEqual([])
  })

  it('records an entry as one event carrying the branch and its base', async () => {
    const output = { enteredWorktree: { path: TREE, branch: 'eng-327', base: 'origin/main' } }

    expect(await draftsFor(succeeded(output))).toEqual([
      { type: 'worktree-entered', path: TREE, branch: 'eng-327', base: 'origin/main' },
    ])
  })

  it('records an exit as one event carrying what became of the worktree', async () => {
    const output = { exitedWorktree: { path: TREE, action: EWorktreeExit.Remove } }

    expect(await draftsFor(succeeded(output))).toEqual([
      { type: 'worktree-exited', path: TREE, action: EWorktreeExit.Remove },
    ])
  })

  it('records nothing when the tool failed, whatever it claimed to have done', async () => {
    const failed: ToolOutcome = { ok: false, reason: 'git refused' }

    expect(await draftsFor(failed)).toEqual([])
  })

  it('ignores an output whose shape does not carry a usable move', async () => {
    expect(await draftsFor(succeeded({ enteredWorktree: { path: '', branch: 'b', base: 'c' } }))).toEqual([])
    expect(await draftsFor(succeeded({ exitedWorktree: { path: TREE, action: 'sideways' } }))).toEqual([])
    expect(await draftsFor(succeeded(null))).toEqual([])
  })
})
