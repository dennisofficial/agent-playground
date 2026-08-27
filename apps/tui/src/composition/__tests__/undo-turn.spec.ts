import {
  stampEvent,
  toThreadId,
  toCallId,
  toEventId,
  toRunId,
  type Event,
  type EventDraft,
} from '@dltech/atlas-core'
import { describe, expect, it } from 'bun:test'

import { EUndo, undoTurn } from '../undo-turn'
import { fakeThreadStore, fakeEventLog } from './fake-backend'

const THREAD = toThreadId('undoing')

const AT = '2026-08-25T00:00:00.000Z'

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
  return { log, threads: fakeThreadStore({ log, existing: [THREAD] }) }
}

describe('undoing the exchange an interrupted turn never answered', () => {
  it('takes the message back and leaves the thread as it was before it was sent', async () => {
    const { log, threads } = backedBy([
      { type: 'user-said', text: 'rewrite the loop' },
      { type: 'assistant-said', parts: [{ type: 'reasoning', text: 'weighing it' }], interrupted: true },
    ])

    const undone = await undoTurn({ log, threads, threadId: THREAD })

    expect(undone).toEqual({ type: EUndo.Restored, text: 'rewrite the loop' })
    expect(await log.read({ threadId: THREAD })).toEqual([])
  })

  it('rewinds only the last exchange, leaving the ones before it durable', async () => {
    const { log, threads } = backedBy([
      { type: 'user-said', text: 'first' },
      { type: 'assistant-said', parts: [{ type: 'text', text: 'answered' }] },
      { type: 'user-said', text: 'second' },
    ])

    const undone = await undoTurn({ log, threads, threadId: THREAD })

    expect(undone).toEqual({ type: EUndo.Restored, text: 'second' })
    expect((await log.read({ threadId: THREAD })).map((event) => event.type)).toEqual([
      'user-said',
      'assistant-said',
    ])
  })

  it('has nothing to undo on a thread the developer never spoke on', async () => {
    const { log, threads } = backedBy([])

    expect(await undoTurn({ log, threads, threadId: THREAD })).toEqual({ type: EUndo.Nothing })
  })

  it('reports the refusal rather than half-rewinding when the target would strand a tool call', async () => {
    const { log, threads } = backedBy([
      { type: 'tool-called', callId: toCallId('call-1'), name: 'write_file', input: {}, ordinal: 0 },
      { type: 'user-said', text: 'stop, do it differently' },
    ])

    const undone = await undoTurn({ log, threads, threadId: THREAD })

    expect(undone.type).toBe(EUndo.Refused)
    expect(undone.type === EUndo.Refused ? undone.reason : '').toContain('write_file')
    expect(await log.read({ threadId: THREAD })).toHaveLength(2)
  })
})
