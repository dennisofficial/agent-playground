import { describe, expect, it } from 'bun:test'

import {
  EToolEffect,
  EWorktreeExit,
  toCallId,
  toThreadId,
  type ToolCall,
  type ToolOutcome,
} from '@dltech/atlas-core'

import { createSessionFacts } from '../session'

const LAUNCH = '/work/atlas'
const TREE = '/work/atlas/.claude/worktrees/thing'

const NEVER_ABORTED = new AbortController().signal

const callOf = (name: string): ToolCall => ({
  callId: toCallId('call-1'),
  name,
  input: {},
  effect: EToolEffect.Destructive,
  threadId: toThreadId('thread-fixture'),
})

const entered = (path: string): ToolOutcome => ({
  ok: true,
  output: { enteredWorktree: { path, branch: 'dennis/thing', base: 'origin/main' } },
  modelText: 'entered',
})

const exited = (path: string): ToolOutcome => ({
  ok: true,
  output: { exitedWorktree: { path, action: EWorktreeExit.Keep } },
  modelText: 'exited',
})

const UNRELATED: ToolOutcome = { ok: true, output: {}, modelText: 'done' }

const REFUSED: ToolOutcome = { ok: false, reason: 'the tool refused' }

describe('session facts follow the worktree the session is standing in', () => {
  it('moves to the worktree the moment enter_worktree lands, mid-turn', async () => {
    const facts = createSessionFacts({ launchDirectory: LAUNCH })
    expect(facts.directory()).toBe(LAUNCH)

    const announced = new Promise<void>((resolve) => facts.subscribe(() => resolve()))
    await facts.followWorktree({ call: callOf('enter_worktree'), result: entered(TREE), signal: NEVER_ABORTED })

    expect(facts.directory()).toBe(TREE)
    await announced
  })

  it('returns to the launch directory when the worktree is exited', async () => {
    const facts = createSessionFacts({ launchDirectory: LAUNCH })
    await facts.followWorktree({ call: callOf('enter_worktree'), result: entered(TREE), signal: NEVER_ABORTED })
    expect(facts.directory()).toBe(TREE)

    await facts.followWorktree({ call: callOf('exit_worktree'), result: exited(TREE), signal: NEVER_ABORTED })
    expect(facts.directory()).toBe(LAUNCH)
  })

  it('stays put when the entry did not succeed', async () => {
    const facts = createSessionFacts({ launchDirectory: LAUNCH })
    const version = facts.version()

    await facts.followWorktree({ call: callOf('enter_worktree'), result: REFUSED, signal: NEVER_ABORTED })

    expect(facts.directory()).toBe(LAUNCH)
    expect(facts.version()).toBe(version)
  })

  it('stays put for a tool that moved no worktree', async () => {
    const facts = createSessionFacts({ launchDirectory: LAUNCH })
    const version = facts.version()

    await facts.followWorktree({ call: callOf('bash'), result: UNRELATED, signal: NEVER_ABORTED })

    expect(facts.directory()).toBe(LAUNCH)
    expect(facts.version()).toBe(version)
  })

  it('writes nothing to the log, because the harness already records the hop', async () => {
    const facts = createSessionFacts({ launchDirectory: LAUNCH })

    const outcome = await facts.followWorktree({
      call: callOf('enter_worktree'),
      result: entered(TREE),
      signal: NEVER_ABORTED,
    })

    expect(outcome).toEqual({})
  })
})

describe('session facts learn the directory when a thread opens', () => {
  it('moves to the worktree a resumed thread is standing in, before any turn runs', async () => {
    const facts = createSessionFacts({ launchDirectory: LAUNCH })
    expect(facts.directory()).toBe(LAUNCH)

    const announced = new Promise<void>((resolve) => facts.subscribe(() => resolve()))
    await facts.threadOpened({ threadId: toThreadId('thread-fixture'), projectDirectory: TREE })

    expect(facts.directory()).toBe(TREE)
    await announced
  })

  it('does not mark the session working — opening a thread runs no turn', async () => {
    const facts = createSessionFacts({ launchDirectory: LAUNCH })

    await facts.threadOpened({ threadId: toThreadId('thread-fixture'), projectDirectory: TREE })

    expect(facts.working()).toBe(false)
  })

  it('returns to the launch directory when a fresh conversation opens', async () => {
    const facts = createSessionFacts({ launchDirectory: LAUNCH })
    await facts.threadOpened({ threadId: toThreadId('thread-fixture'), projectDirectory: TREE })
    expect(facts.directory()).toBe(TREE)

    await facts.threadOpened({ threadId: toThreadId('thread-new'), projectDirectory: LAUNCH })
    expect(facts.directory()).toBe(LAUNCH)
  })

  it('says nothing when the opened thread stands where it already stood', async () => {
    const facts = createSessionFacts({ launchDirectory: LAUNCH })
    const version = facts.version()

    const outcome = await facts.threadOpened({
      threadId: toThreadId('thread-fixture'),
      projectDirectory: LAUNCH,
    })

    expect(outcome).toEqual({})
    expect(facts.version()).toBe(version)
  })
})
