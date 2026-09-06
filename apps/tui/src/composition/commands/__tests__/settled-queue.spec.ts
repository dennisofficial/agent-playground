import { describe, expect, it } from 'bun:test'

import { RAN } from '../local-command'
import {
  createSettledQueue,
  droppedNotice,
  queuedNotice,
  unqueuedNotice,
  type QueuedSettled,
} from '../settled-queue'

const compact: QueuedSettled = {
  name: 'compact',
  dropsQueue: false,
  losesWaiting: false,
  run: () => RAN,
}
const compactAll: QueuedSettled = {
  name: 'compact',
  dropsQueue: false,
  losesWaiting: false,
  run: () => RAN,
}
const rewind: QueuedSettled = {
  name: 'rewind',
  dropsQueue: false,
  losesWaiting: false,
  run: () => RAN,
}
const fresh: QueuedSettled = { name: 'new', dropsQueue: true, losesWaiting: false, run: () => RAN }

describe('createSettledQueue', () => {
  it('queues commands in the order they were submitted', () => {
    const queue = createSettledQueue()

    queue.toggle(compact)
    queue.toggle(rewind)

    expect(queue.names()).toEqual(['compact', 'rewind'])
  })

  it('toggles a command back out of the queue when submitted again', () => {
    const queue = createSettledQueue()

    expect(queue.toggle(compact)).toBe(true)
    expect(queue.toggle(compactAll)).toBe(false)

    expect(queue.names()).toEqual([])
  })

  it('keeps the remaining commands in order after a toggle-off', () => {
    const queue = createSettledQueue()

    queue.toggle(compact)
    queue.toggle(rewind)
    queue.toggle(fresh)
    queue.toggle(rewind)

    expect(queue.names()).toEqual(['compact', 'new'])
  })

  it('drains every queued command in submission order and leaves the queue empty', () => {
    const queue = createSettledQueue()

    queue.toggle(compact)
    queue.toggle(fresh)

    expect(queue.drain()).toEqual([compact, fresh])
    expect(queue.names()).toEqual([])
  })

  it('drains nothing that was never queued', () => {
    expect(createSettledQueue().drain()).toEqual([])
  })

  it('clears without handing anything back', () => {
    const queue = createSettledQueue()

    queue.toggle(compact)
    queue.clear()

    expect(queue.names()).toEqual([])
    expect(queue.drain()).toEqual([])
  })
})

describe('queuedNotice', () => {
  it('names the one command that will run when the turn finishes', () => {
    expect(queuedNotice(['compact'])).toBe('/compact queued — runs when this turn finishes')
  })

  it('lists every queued command in the order they will run', () => {
    expect(queuedNotice(['compact', 'new'])).toBe(
      'queued for when this turn finishes: /compact, /new',
    )
  })
})

describe('unqueuedNotice', () => {
  it('confirms the command came back out of the queue', () => {
    expect(unqueuedNotice('compact')).toBe('/compact taken out of the queue')
  })
})

describe('droppedNotice', () => {
  it('says nothing when nothing was dropped', () => {
    expect(droppedNotice({ command: 'new', messages: 0, commands: [] })).toBeNull()
  })

  it('names one dropped message without a count', () => {
    expect(droppedNotice({ command: 'new', messages: 1, commands: [] })).toBe(
      '/new dropped a queued message',
    )
  })

  it('counts several dropped messages', () => {
    expect(droppedNotice({ command: 'resume', messages: 2, commands: [] })).toBe(
      '/resume dropped 2 queued messages',
    )
  })

  it('names the queued commands that will never run', () => {
    expect(droppedNotice({ command: 'restart', messages: 0, commands: ['compact'] })).toBe(
      '/restart dropped /compact',
    )
  })

  it('joins dropped messages and commands into one sentence', () => {
    expect(droppedNotice({ command: 'new', messages: 2, commands: ['compact'] })).toBe(
      '/new dropped 2 queued messages and /compact',
    )
  })
})
