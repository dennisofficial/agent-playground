import { toThreadId } from '@dltech/atlas-core'
import { describe, expect, it } from 'bun:test'

import { createPendingQueues } from '../pending-queues'

const THREAD_A = toThreadId('thread-a')
const THREAD_B = toThreadId('thread-b')

const textsOf = (queue: { getSnapshot: () => readonly { text: string }[] }) =>
  queue.getSnapshot().map((message) => message.text)

describe('the queues messages wait in, one per thread', () => {
  it('keeps what was typed for one thread out of another', () => {
    const queues = createPendingQueues()

    queues.forThread({ threadId: THREAD_A }).enqueue({ text: 'meant for A' })

    expect(queues.forThread({ threadId: THREAD_B }).getSnapshot()).toEqual([])
    expect(textsOf(queues.forThread({ threadId: THREAD_A }))).toEqual(['meant for A'])
  })

  it('hands the same queue back when the thread is opened again, so what waited is still there', () => {
    const queues = createPendingQueues()
    const first = queues.forThread({ threadId: THREAD_A })
    first.enqueue({ text: 'still mine' })

    expect(queues.forThread({ threadId: THREAD_A })).toBe(first)
    expect(textsOf(queues.forThread({ threadId: THREAD_A }))).toEqual(['still mine'])
  })

  it('drains the thread the turn belongs to without touching another', () => {
    const queues = createPendingQueues()
    queues.forThread({ threadId: THREAD_A }).enqueue({ text: 'for A' })
    queues.forThread({ threadId: THREAD_B }).enqueue({ text: 'for B' })

    expect(queues.forThread({ threadId: THREAD_A }).drain().map((said) => said.text)).toEqual([
      'for A',
    ])
    expect(textsOf(queues.forThread({ threadId: THREAD_B }))).toEqual(['for B'])
  })

  it('counts what is still waiting across every thread', () => {
    const queues = createPendingQueues()

    expect(queues.waitingCount()).toBe(0)

    queues.forThread({ threadId: THREAD_A }).enqueue({ text: 'one' })
    queues.forThread({ threadId: THREAD_B }).enqueue({ text: 'two' })
    expect(queues.waitingCount()).toBe(2)
  })

  it('stops counting a message once the loop has taken it, because the log holds it then', () => {
    const queues = createPendingQueues()
    const mine = queues.forThread({ threadId: THREAD_A })
    mine.enqueue({ text: 'taken' })
    queues.forThread({ threadId: THREAD_B }).enqueue({ text: 'waiting' })

    mine.drain()

    expect(queues.waitingCount()).toBe(1)
  })
})
