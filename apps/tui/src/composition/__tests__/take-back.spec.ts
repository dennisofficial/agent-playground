import {
  EShellStatus,
  stampEvent,
  toThreadId,
  toEventId,
  toRunId,
  type Event,
  type EventDraft,
} from '@dltech/atlas-core'
import { toShellId } from '@dltech/atlas-harness'
import { describe, expect, it } from 'bun:test'

import { retractTrailingSaid } from '../take-back'
import { fakeAgentRegistry } from './fake-agents'
import { fakeThreadStore, fakeEventLog } from './fake-backend'

const THREAD = toThreadId('take-back')

const AT = '2026-09-06T00:00:00.000Z'

const stamped = (drafts: readonly EventDraft[]): Event[] =>
  drafts.map((draft, index) =>
    stampEvent({
      draft,
      envelope: {
        id: toEventId(`event-${index + 1}`),
        seq: index + 1,
        threadId: THREAD,
        runId: toRunId('run-1'),
        depth: 0,
        at: AT,
      },
    }),
  )

const backedBy = (drafts: readonly EventDraft[]) => {
  const log = fakeEventLog(stamped(drafts))
  return { log, threads: fakeThreadStore({ log, existing: [THREAD] }), agents: fakeAgentRegistry() }
}

const SHELL_ENDED: EventDraft = {
  type: 'background-shell-ended',
  shellId: toShellId('bash_1'),
  command: 'bun test',
  description: 'Run full TUI suite',
  status: EShellStatus.Exited,
  exitCode: 0,
  output: '566 pass',
  droppedCharacters: 0,
  remainingCharacters: 8,
}

describe('taking back a message the loop already drained', () => {
  it('retracts it while it is still the last thing said, leaving the notices drained with it', async () => {
    const { log, threads, agents } = backedBy([
      { type: 'user-said', text: 'start' },
      SHELL_ENDED,
      { type: 'user-said', text: 'check the tests too' },
    ])

    const retracted = await retractTrailingSaid({
      log,
      threads,
      agents,
      threadId: THREAD,
      text: 'check the tests too',
    })

    expect(retracted).toBe(true)
    expect((await log.read({ threadId: THREAD })).map((event) => event.type)).toEqual([
      'user-said',
      'background-shell-ended',
    ])
  })

  it('retracts only the last of a taken batch, one press at a time', async () => {
    const { log, threads, agents } = backedBy([
      { type: 'user-said', text: 'first' },
      { type: 'user-said', text: 'second' },
    ])

    expect(await retractTrailingSaid({ log, threads, agents, threadId: THREAD, text: 'second' })).toBe(true)
    expect((await log.read({ threadId: THREAD })).map((event) => event.type)).toEqual(['user-said'])

    expect(await retractTrailingSaid({ log, threads, agents, threadId: THREAD, text: 'first' })).toBe(true)
    expect(await log.read({ threadId: THREAD })).toEqual([])
  })

  it('refuses once anything followed it — the agent has it now — and touches nothing', async () => {
    const { log, threads, agents } = backedBy([
      { type: 'user-said', text: 'check the tests too' },
      { type: 'assistant-said', parts: [{ type: 'text', text: 'on it' }] },
    ])

    const retracted = await retractTrailingSaid({
      log,
      threads,
      agents,
      threadId: THREAD,
      text: 'check the tests too',
    })

    expect(retracted).toBe(false)
    expect((await log.read({ threadId: THREAD })).length).toBe(2)
  })

  it('refuses when the tail is a notice rather than the message', async () => {
    const { log, threads, agents } = backedBy([{ type: 'user-said', text: 'check the tests too' }, SHELL_ENDED])

    const retracted = await retractTrailingSaid({
      log,
      threads,
      agents,
      threadId: THREAD,
      text: 'check the tests too',
    })

    expect(retracted).toBe(false)
    expect((await log.read({ threadId: THREAD })).length).toBe(2)
  })
})
