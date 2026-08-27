import { describe, expect, it } from 'bun:test'

import type { EventDraft } from '../../events/body'
import type { Event } from '../../events/envelope'
import { toBranchId, toEventId, toRunId, type BranchId, type RunId } from '../../events/ids'
import { stampEvent } from '../../events/stamp'
import type { ClockPort } from '../clock.port'
import type { EventLogPort } from '../event-log.port'

const fakeClock = (): ClockPort => {
  let ticks = 0
  return { now: () => new Date(Date.UTC(2026, 0, 1, 0, 0, ticks++)).toISOString() }
}

const fakeLog = (): EventLogPort => {
  const clock = fakeClock()
  const branches = new Map<BranchId, Event[]>()
  const of = (branchId: BranchId): Event[] => {
    const existing = branches.get(branchId)
    if (existing) return existing
    const created: Event[] = []
    branches.set(branchId, created)
    return created
  }

  return {
    async append({ branchId, runId, drafts }: { branchId: BranchId; runId: RunId; drafts: readonly EventDraft[] }) {
      const stored = of(branchId)
      return drafts.map((draft) => {
        const seq = stored.length + 1
        const event = stampEvent({
          draft,
          envelope: { id: toEventId(`evt-${seq}`), seq, branchId, runId, depth: 0, at: clock.now() },
        })
        stored.push(event)
        return event
      })
    },
    async read({ branchId, upTo }) {
      const stored = of(branchId)
      if (upTo === undefined) return [...stored]
      return stored.filter((event) => event.seq <= upTo)
    },
    async head({ branchId }) {
      return of(branchId).length
    },
    async readOwn({ branchId, upTo }) {
      const stored = of(branchId)
      if (upTo === undefined) return [...stored]
      return stored.filter((event) => event.seq <= upTo)
    },
  }
}

const branchId = toBranchId('branch-1')
const runId = toRunId('run-1')

describe('EventLogPort', () => {
  it('stamps a batch of drafts in order, from sequence one', async () => {
    const log = fakeLog()

    const appended = await log.append({
      branchId,
      runId,
      drafts: [
        { type: 'user-said', text: 'hello' },
        { type: 'assistant-said', parts: [{ type: 'text', text: 'hi' }] },
      ],
    })

    expect(appended.map((event) => [event.type, event.seq])).toEqual([
      ['user-said', 1],
      ['assistant-said', 2],
    ])
  })

  it('reads a branch back in sequence order', async () => {
    const log = fakeLog()
    await log.append({ branchId, runId, drafts: [{ type: 'user-said', text: 'first' }] })
    await log.append({ branchId, runId, drafts: [{ type: 'user-said', text: 'second' }] })

    const events = await log.read({ branchId })

    expect(events.map((event) => event.seq)).toEqual([1, 2])
  })

  it('reads a prefix of a branch when given an upper bound', async () => {
    const log = fakeLog()
    await log.append({
      branchId,
      runId,
      drafts: [
        { type: 'user-said', text: 'first' },
        { type: 'user-said', text: 'second' },
      ],
    })

    expect(await log.read({ branchId, upTo: 1 })).toHaveLength(1)
  })

  it('reports the head of a branch nothing has been appended to as zero', async () => {
    expect(await fakeLog().head({ branchId })).toBe(0)
  })
})
