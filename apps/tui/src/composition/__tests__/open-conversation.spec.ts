import { toThreadId, toEventId, toRunId, type Event } from '@dltech/atlas-core'
import { describe, expect, it } from 'bun:test'

import { ETurnStatus, type TurnSpend } from '@dltech/atlas-harness'

import { openConversation } from '../open-conversation'
import { fakeThreadStore, fakeEventLog, fakeLedger } from './fake-backend'

const YESTERDAY = toThreadId('yesterday')

const spent: TurnSpend = {
  threadId: YESTERDAY,
  runId: toRunId('r1'),
  status: ETurnStatus.Completed,
  providerId: 'anthropic',
  modelId: 'claude-opus-5',
  steps: 1,
  inputTokens: 1_000,
  outputTokens: 222,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  startedAt: '2026-08-24T00:00:00.000Z',
  endedAt: '2026-08-24T00:00:03.000Z',
  durationMs: 3_000,
}

const said = (text: string): Event => ({
  type: 'user-said',
  text,
  id: toEventId('e1'),
  seq: 1,
  threadId: YESTERDAY,
  runId: toRunId('r1'),
  depth: 0,
  at: '2026-08-24T00:00:00.000Z',
})

describe('which conversation the app opens on', () => {
  it('opens on the most recent one, with everything it already held', async () => {
    const threads = fakeThreadStore({ existing: [toThreadId('older'), YESTERDAY] })
    const log = fakeEventLog([said('carry this on')])

    const opened = await openConversation({ threads, log, ledger: fakeLedger(), fresh: false })

    expect(opened.threadId).toBe(YESTERDAY)
    expect(opened.events).toHaveLength(1)
    expect(threads.created).toBe(0)
  })

  it('carries what its turns already spent, so the lines are drawn on the first frame', async () => {
    const threads = fakeThreadStore({ existing: [YESTERDAY] })
    const log = fakeEventLog([said('carry this on')])

    const opened = await openConversation({
      threads,
      log,
      ledger: fakeLedger({ spent: [spent] }),
      fresh: false,
    })

    expect(opened.turns).toEqual([spent])
  })

  it('starts one when there is none, so first run is not an error state', async () => {
    const threads = fakeThreadStore()
    const log = fakeEventLog()

    const opened = await openConversation({ threads, log, ledger: fakeLedger(), fresh: false })

    expect(threads.created).toBe(1)
    expect(opened.events).toEqual([])
  })

  it('starts a fresh one when asked, without touching the last', async () => {
    const threads = fakeThreadStore({ existing: [YESTERDAY] })
    const log = fakeEventLog([said('do not pollute this')])

    const opened = await openConversation({
      threads,
      log,
      ledger: fakeLedger({ spent: [spent] }),
      fresh: true,
    })

    expect(opened.threadId).not.toBe(YESTERDAY)
    expect(opened.events).toEqual([])
    expect(opened.turns).toEqual([])
    expect(threads.created).toBe(1)
  })
})
