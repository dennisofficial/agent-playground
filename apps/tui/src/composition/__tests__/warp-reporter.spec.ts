import { describe, expect, it } from 'bun:test'

import { toCallId, toRunId, toThreadId } from '@dltech/atlas-core'
import { ETurnStatus } from '@dltech/atlas-harness'

import {
  createWarpReporter,
  reportWarpOutcome,
  WarpThreadOpenHook,
  type WarpReporter,
} from '../warp-reporter'
import { fakeEventLog } from './fake-backend'

const WARP_ENV = { TERM_PROGRAM: 'WarpTerminal' }

const THREAD = toThreadId('thread-warp')

function capturedReporter(): { reporter: WarpReporter; writes: string[] } {
  const writes: string[] = []
  const reporter = createWarpReporter({
    env: WARP_ENV,
    write: (sequence) => writes.push(sequence),
    host: 'mac.local',
  })
  if (reporter === null) throw new Error('expected a reporter inside Warp')
  return { reporter, writes }
}

describe('createWarpReporter', () => {
  it('is null outside Warp', () => {
    expect(
      createWarpReporter({ env: {}, write: () => undefined, host: 'mac.local' }),
    ).toBeNull()
    expect(
      createWarpReporter({
        env: { TERM_PROGRAM: 'iTerm.app' },
        write: () => undefined,
        host: 'mac.local',
      }),
    ).toBeNull()
  })

  it('creates a reporter inside Warp', () => {
    expect(
      createWarpReporter({ env: WARP_ENV, write: () => undefined, host: 'mac.local' }),
    ).not.toBeNull()
  })
})

describe('OscWarpReporter', () => {
  it('points the tab at the opened directory via OSC 7', () => {
    const { reporter, writes } = capturedReporter()
    reporter.handleThreadOpened({ projectDirectory: '/Users/dennis/atlas' })

    expect(writes).toEqual(['\x1b]7;file://mac.local/Users/dennis/atlas\x1b\\'])
  })

  it('follows the directory on every thread open, including worktrees', () => {
    const { reporter, writes } = capturedReporter()
    reporter.handleThreadOpened({ projectDirectory: '/Users/dennis/atlas' })
    reporter.handleThreadOpened({
      projectDirectory: '/Users/dennis/atlas/.atlas/worktrees/warp integration',
    })

    expect(writes.at(-1)).toBe(
      '\x1b]7;file://mac.local/Users/dennis/atlas/.atlas/worktrees/warp%20integration\x1b\\',
    )
  })

  it('pops a plain notification when a turn completes, titled with the project', () => {
    const { reporter, writes } = capturedReporter()
    reporter.handleThreadOpened({ projectDirectory: '/Users/dennis/atlas' })
    reporter.handleTurnCompleted({ response: 'shipped it' })

    expect(writes.at(-1)).toBe('\x1b]777;notify;Atlas — atlas;shipped it\x07')
  })

  it('pops a plain notification when approval is needed', () => {
    const { reporter, writes } = capturedReporter()
    reporter.handleThreadOpened({ projectDirectory: '/x' })
    reporter.handlePermissionRequest({ summary: 'Wants to run bash: rm -rf dist' })

    expect(writes.at(-1)).toBe('\x1b]777;notify;Atlas — x;Wants to run bash: rm -rf dist\x07')
  })

  it('says nothing for an empty response', () => {
    const { reporter, writes } = capturedReporter()
    reporter.handleThreadOpened({ projectDirectory: '/x' })
    writes.length = 0
    reporter.handleTurnCompleted({ response: '' })

    expect(writes).toEqual([])
  })

  it('truncates a long response to the notification limit', () => {
    const { reporter, writes } = capturedReporter()
    reporter.handleThreadOpened({ projectDirectory: '/x' })
    reporter.handleTurnCompleted({ response: 'a'.repeat(500) })

    expect(writes.at(-1)).toBe(`\x1b]777;notify;Atlas — x;${'a'.repeat(197)}...\x07`)
  })

  it('survives a write that throws', () => {
    const reporter = createWarpReporter({
      env: WARP_ENV,
      write: () => {
        throw new Error('EPIPE')
      },
      host: 'mac.local',
    })
    reporter?.handleThreadOpened({ projectDirectory: '/x' })
    reporter?.handleTurnCompleted({ response: 'still alive' })
  })
})

describe('WarpThreadOpenHook', () => {
  it('forwards the opened directory', async () => {
    const { reporter, writes } = capturedReporter()
    const hook = new WarpThreadOpenHook(reporter)
    const outcome = await hook.run({
      threadId: THREAD,
      projectDirectory: '/Users/dennis/atlas',
    })

    expect(outcome).toEqual({})
    expect(writes).toEqual(['\x1b]7;file://mac.local/Users/dennis/atlas\x1b\\'])
  })
})

describe('reportWarpOutcome', () => {
  it('does nothing without a reporter', async () => {
    const log = fakeEventLog()
    await reportWarpOutcome({
      reporter: null,
      log,
      threadId: THREAD,
      outcome: { status: ETurnStatus.Completed, runId: toRunId('run-1') },
      asked: null,
    })
    expect(log.branchesRead).toEqual([])
  })

  it('notifies with the trailing response on a completed turn', async () => {
    const { reporter, writes } = capturedReporter()
    reporter.handleThreadOpened({ projectDirectory: '/x' })
    writes.length = 0

    const log = fakeEventLog()
    await log.append({
      threadId: THREAD,
      runId: toRunId('run-1'),
      drafts: [
        { type: 'user-said', text: 'ship it' },
        { type: 'assistant-said', parts: [{ type: 'text', text: 'shipped' }] },
      ],
    })

    await reportWarpOutcome({
      reporter,
      log,
      threadId: THREAD,
      outcome: { status: ETurnStatus.Completed, runId: toRunId('run-1') },
      asked: null,
    })

    expect(writes.at(-1)).toBe('\x1b]777;notify;Atlas — x;shipped\x07')
  })

  it('notifies with the permission summary joined back to the tool call', async () => {
    const { reporter, writes } = capturedReporter()
    reporter.handleThreadOpened({ projectDirectory: '/x' })
    writes.length = 0

    const log = fakeEventLog()
    await log.append({
      threadId: THREAD,
      runId: toRunId('run-1'),
      drafts: [
        { type: 'user-said', text: 'clean up' },
        {
          type: 'tool-called',
          callId: toCallId('call-9'),
          name: 'bash',
          input: { command: 'rm -rf dist' },
          ordinal: 0,
        },
        { type: 'approval-requested', callId: toCallId('call-9'), reason: 'destructive' },
      ],
    })

    await reportWarpOutcome({
      reporter,
      log,
      threadId: THREAD,
      outcome: {
        status: ETurnStatus.Paused,
        runId: toRunId('run-1'),
        callId: toCallId('call-9'),
        reason: 'destructive',
      },
      asked: { callId: toCallId('call-9'), reason: 'destructive', evidence: [], dimensions: [] },
    })

    expect(writes.at(-1)).toBe('\x1b]777;notify;Atlas — x;Wants to run bash: rm -rf dist\x07')
  })

  it('stays quiet on an interrupted turn', async () => {
    const { reporter, writes } = capturedReporter()
    reporter.handleThreadOpened({ projectDirectory: '/x' })
    writes.length = 0

    await reportWarpOutcome({
      reporter,
      log: fakeEventLog(),
      threadId: THREAD,
      outcome: { status: ETurnStatus.Interrupted, runId: toRunId('run-1'), committed: false },
      asked: null,
    })

    expect(writes).toEqual([])
  })
})
