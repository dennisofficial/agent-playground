import { toBranchId, toEventId, toRunId, type Event } from '@dltech/atlas-core'
import { describe, expect, it } from 'bun:test'

import { openConversation } from '../open-conversation'
import { fakeBranchStore, fakeEventLog } from './fake-backend'

const YESTERDAY = toBranchId('yesterday')

const said = (text: string): Event => ({
  type: 'user-said',
  text,
  id: toEventId('e1'),
  seq: 1,
  branchId: YESTERDAY,
  runId: toRunId('r1'),
  depth: 0,
  at: '2026-08-24T00:00:00.000Z',
})

describe('which conversation the app opens on', () => {
  it('opens on the most recent one, with everything it already held', async () => {
    const branches = fakeBranchStore({ existing: [toBranchId('older'), YESTERDAY] })
    const log = fakeEventLog([said('carry this on')])

    const opened = await openConversation({ branches, log, fresh: false })

    expect(opened.branchId).toBe(YESTERDAY)
    expect(opened.events).toHaveLength(1)
    expect(branches.created).toBe(0)
  })

  it('starts one when there is none, so first run is not an error state', async () => {
    const branches = fakeBranchStore()
    const log = fakeEventLog()

    const opened = await openConversation({ branches, log, fresh: false })

    expect(branches.created).toBe(1)
    expect(opened.events).toEqual([])
  })

  it('starts a fresh one when asked, without touching the last', async () => {
    const branches = fakeBranchStore({ existing: [YESTERDAY] })
    const log = fakeEventLog([said('do not pollute this')])

    const opened = await openConversation({ branches, log, fresh: true })

    expect(opened.branchId).not.toBe(YESTERDAY)
    expect(opened.events).toEqual([])
    expect(branches.created).toBe(1)
  })
})
