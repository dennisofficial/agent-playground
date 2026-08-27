import { describe, expect, it } from 'bun:test'

import type { EventDraft } from '../../events/body'
import type { Event } from '../../events/envelope'
import { toThreadId, toEventId, toRunId, type ThreadId, type RunId } from '../../events/ids'
import { stampEvent } from '../../events/stamp'
import type { ClockPort } from '../clock.port'
import type { EventLogPort } from '../event-log.port'

const fakeClock = (): ClockPort => {
  let ticks = 0
  return { now: () => new Date(Date.UTC(2026, 0, 1, 0, 0, ticks++)).toISOString() }
}

const fakeLog = (): EventLogPort => {
  const clock = fakeClock()
  const threads = new Map<ThreadId, Event[]>()
  const of = (threadId: ThreadId): Event[] => {
    const existing = threads.get(threadId)
    if (existing) return existing
    const created: Event[] = []
    threads.set(threadId, created)
    return created
  }

  return {
    async append({ threadId, runId, drafts }: { threadId: ThreadId; runId: RunId; drafts: readonly EventDraft[] }) {
      const stored = of(threadId)
      return drafts.map((draft) => {
        const seq = stored.length + 1
        const event = stampEvent({
          draft,
          envelope: { id: toEventId(`evt-${seq}`), seq, threadId, runId, depth: 0, at: clock.now() },
        })
        stored.push(event)
        return event
      })
    },
    async read({ threadId, upTo }) {
      const stored = of(threadId)
      if (upTo === undefined) return [...stored]
      return stored.filter((event) => event.seq <= upTo)
    },
    async head({ threadId }) {
      return of(threadId).length
    },
    async readOwn({ threadId, upTo }) {
      const stored = of(threadId)
      if (upTo === undefined) return [...stored]
      return stored.filter((event) => event.seq <= upTo)
    },
  }
}

const threadId = toThreadId('thread-1')
const runId = toRunId('run-1')

describe('EventLogPort', () => {
  it('stamps a batch of drafts in order, from sequence one', async () => {
    const log = fakeLog()

    const appended = await log.append({
      threadId,
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

  it('reads a thread back in sequence order', async () => {
    const log = fakeLog()
    await log.append({ threadId, runId, drafts: [{ type: 'user-said', text: 'first' }] })
    await log.append({ threadId, runId, drafts: [{ type: 'user-said', text: 'second' }] })

    const events = await log.read({ threadId })

    expect(events.map((event) => event.seq)).toEqual([1, 2])
  })

  it('reads a prefix of a thread when given an upper bound', async () => {
    const log = fakeLog()
    await log.append({
      threadId,
      runId,
      drafts: [
        { type: 'user-said', text: 'first' },
        { type: 'user-said', text: 'second' },
      ],
    })

    expect(await log.read({ threadId, upTo: 1 })).toHaveLength(1)
  })

  it('reports the head of a thread nothing has been appended to as zero', async () => {
    expect(await fakeLog().head({ threadId })).toBe(0)
  })
})
