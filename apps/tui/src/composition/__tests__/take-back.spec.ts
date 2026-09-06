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

import { ETakeBack, takeBackTrailingSaid } from '../take-back'
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
  it('retracts it while it is still the last thing said, and hands its text back', async () => {
    const { log, threads, agents } = backedBy([
      { type: 'user-said', text: 'start' },
      SHELL_ENDED,
      { type: 'user-said', text: 'check the tests too' },
    ])

    const taken = await takeBackTrailingSaid({ log, threads, agents, threadId: THREAD })

    expect(taken).toEqual({
      type: ETakeBack.Taken,
      said: { text: 'check the tests too', images: [] },
    })
    expect((await log.read({ threadId: THREAD })).map((event) => event.type)).toEqual([
      'user-said',
      'background-shell-ended',
    ])
  })

  it('retracts only the last of a drained batch, one press at a time', async () => {
    const { log, threads, agents } = backedBy([
      { type: 'user-said', text: 'first' },
      { type: 'user-said', text: 'second' },
    ])

    const second = await takeBackTrailingSaid({ log, threads, agents, threadId: THREAD })
    expect(second.type).toBe(ETakeBack.Taken)
    expect(second.type === ETakeBack.Taken && second.said.text).toBe('second')
    expect((await log.read({ threadId: THREAD })).map((event) => event.type)).toEqual(['user-said'])

    const first = await takeBackTrailingSaid({ log, threads, agents, threadId: THREAD })
    expect(first.type === ETakeBack.Taken && first.said.text).toBe('first')
    expect(await log.read({ threadId: THREAD })).toEqual([])
  })

  it('finds nothing once the agent has answered — the edit is a follow-up now', async () => {
    const { log, threads, agents } = backedBy([
      { type: 'user-said', text: 'check the tests too' },
      { type: 'assistant-said', parts: [{ type: 'text', text: 'on it' }] },
    ])

    const taken = await takeBackTrailingSaid({ log, threads, agents, threadId: THREAD })

    expect(taken.type).toBe(ETakeBack.Nothing)
    expect((await log.read({ threadId: THREAD })).length).toBe(2)
  })

  it('finds nothing when the tail is a notice rather than the message', async () => {
    const { log, threads, agents } = backedBy([
      { type: 'user-said', text: 'check the tests too' },
      SHELL_ENDED,
    ])

    const taken = await takeBackTrailingSaid({ log, threads, agents, threadId: THREAD })

    expect(taken.type).toBe(ETakeBack.Nothing)
    expect((await log.read({ threadId: THREAD })).length).toBe(2)
  })
})
