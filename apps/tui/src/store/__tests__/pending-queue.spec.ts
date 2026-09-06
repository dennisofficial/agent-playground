import { describe, expect, it } from 'bun:test'

import { createPendingQueue } from '../pending-queue'

const textsOf = (queue: { getSnapshot: () => readonly { text: string }[] }) =>
  queue.getSnapshot().map((entry) => entry.text)

describe('the queue submissions wait in, under the working indicator', () => {
  it('holds what was typed, in the order it was typed', () => {
    const queue = createPendingQueue()

    queue.enqueue({ text: 'check the tests too' })
    queue.enqueue({ text: 'and the fixtures' })

    expect(textsOf(queue)).toEqual(['check the tests too', 'and the fixtures'])
  })

  it('hands the whole queue to a drain and keeps nothing back', () => {
    const queue = createPendingQueue()
    queue.enqueue({ text: 'first' })
    queue.enqueue({ text: 'second' })

    expect(queue.drain().map((said) => said.text)).toEqual(['first', 'second'])
    expect(queue.getSnapshot()).toEqual([])
    expect(queue.drain()).toEqual([])
  })

  it('gives back the most recent submission when it is taken back, and forgets it', () => {
    const queue = createPendingQueue()
    queue.enqueue({ text: 'first' })
    queue.enqueue({ text: 'second' })

    expect(queue.takeBackLast()?.text).toBe('second')
    expect(textsOf(queue)).toEqual(['first'])
  })

  it('has nothing to give back from an empty queue', () => {
    expect(createPendingQueue().takeBackLast()).toBeNull()
  })

  it('tells its listeners on every change and stops when they leave', () => {
    const queue = createPendingQueue()
    let told = 0
    const leave = queue.subscribe(() => {
      told += 1
    })

    queue.enqueue({ text: 'one' })
    queue.takeBackLast()
    queue.enqueue({ text: 'two' })
    queue.drain()
    expect(told).toBe(4)

    leave()
    queue.enqueue({ text: 'unheard' })
    expect(told).toBe(4)
  })

  it('stays quiet when a drain finds nothing, so an idle loop does not re-render the app', () => {
    const queue = createPendingQueue()
    let told = 0
    queue.subscribe(() => {
      told += 1
    })

    queue.drain()
    queue.drain()

    expect(told).toBe(0)
  })

  it('keeps one snapshot identity between changes, so a subscribed render settles', () => {
    const queue = createPendingQueue()
    queue.enqueue({ text: 'one' })

    const first = queue.getSnapshot()
    expect(queue.getSnapshot()).toBe(first)

    queue.enqueue({ text: 'two' })
    expect(queue.getSnapshot()).not.toBe(first)
  })

  it('gives every queued submission its own key, so two identical ones still render apart', () => {
    const queue = createPendingQueue()
    queue.enqueue({ text: 'same' })
    queue.enqueue({ text: 'same' })

    const [first, second] = queue.getSnapshot()
    expect(first?.id).not.toBe(second?.id)
  })
})

describe('commands queued between the messages', () => {
  const queueWith = () => createPendingQueue<{ name: string }>()

  it('holds commands and messages in the order they were submitted', () => {
    const queue = queueWith()

    queue.enqueue({ text: 'check the tests too' })
    queue.enqueueCommand({ text: '/compact', command: { name: 'compact' } })
    queue.enqueue({ text: 'and the fixtures' })

    expect(queue.getSnapshot().map((entry) => entry.text)).toEqual([
      'check the tests too',
      '/compact',
      'and the fixtures',
    ])
  })

  it('drains only the messages for the loop, leaving the commands queued', () => {
    const queue = queueWith()
    queue.enqueueCommand({ text: '/new', command: { name: 'new' } })
    queue.enqueue({ text: 'wait, do X instead' })

    expect(queue.drain().map((said) => said.text)).toEqual(['wait, do X instead'])
    expect(queue.getSnapshot().map((entry) => entry.text)).toEqual(['/new'])
  })

  it('hands the settle drain every command in order and keeps the messages', () => {
    const queue = queueWith()
    queue.enqueue({ text: 'still thinking out loud' })
    queue.enqueueCommand({ text: '/compact', command: { name: 'compact' } })
    queue.enqueueCommand({ text: '/new', command: { name: 'new' } })

    const drained = queue.drainCommands()

    expect(drained.map((entry) => entry.text)).toEqual(['/compact', '/new'])
    expect(queue.getSnapshot().map((entry) => entry.text)).toEqual(['still thinking out loud'])
  })

  it('gives a queued command back to the composer on take-back, like any message', () => {
    const queue = queueWith()
    queue.enqueueCommand({ text: '/new', command: { name: 'new' } })

    expect(queue.takeBackLast()?.text).toBe('/new')
    expect(queue.getSnapshot()).toEqual([])
  })

  it('takes back the latest submission, whatever kind it is', () => {
    const queue = queueWith()
    queue.enqueue({ text: 'first a message' })
    queue.enqueueCommand({ text: '/rewind', command: { name: 'rewind' } })

    expect(queue.takeBackLast()?.text).toBe('/rewind')
    expect(queue.takeBackLast()?.text).toBe('first a message')
    expect(queue.takeBackLast()).toBeNull()
  })
})
