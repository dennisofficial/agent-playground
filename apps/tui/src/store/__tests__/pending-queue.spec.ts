import { describe, expect, it } from 'bun:test'

import { createPendingQueue, trailingSaid } from '../pending-queue'
import { log } from './fixture'

const textsOf = (queue: { getSnapshot: () => readonly { text: string }[] }) =>
  queue.getSnapshot().map((message) => message.text)

describe('the queue a message waits in until the loop takes it', () => {
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

    expect(queue.drain()).toEqual(['first', 'second'])
    expect(queue.drain()).toEqual([])
  })

  it('keeps showing what it handed over, so the message is never off the screen', () => {
    const queue = createPendingQueue()
    queue.enqueue({ text: 'first' })
    queue.drain()

    expect(textsOf(queue)).toEqual(['first'])
  })

  it('lets it go once the log it was handed to has it', () => {
    const queue = createPendingQueue()
    queue.enqueue({ text: 'first' })
    queue.drain()

    queue.settleTaken({ landed: ['first'] })

    expect(textsOf(queue)).toEqual([])
  })

  it('lets it go when the turn that carried it opened with a message of its own', () => {
    const queue = createPendingQueue()
    queue.enqueue({ text: 'queued' })
    queue.drain()

    queue.settleTaken({ landed: ['queued', 'and this one'] })

    expect(textsOf(queue)).toEqual([])
  })

  it('holds on when the read that came back does not have it yet', () => {
    const queue = createPendingQueue()
    queue.enqueue({ text: 'first' })
    queue.drain()

    queue.settleTaken({ landed: [] })
    queue.settleTaken({ landed: ['something else'] })

    expect(textsOf(queue)).toEqual(['first'])
  })

  it('shows what it handed over ahead of what is still waiting', () => {
    const queue = createPendingQueue()
    queue.enqueue({ text: 'taken' })
    queue.drain()
    queue.enqueue({ text: 'waiting' })

    expect(textsOf(queue)).toEqual(['taken', 'waiting'])

    queue.settleTaken({ landed: ['taken'] })
    expect(textsOf(queue)).toEqual(['waiting'])
  })

  it('returns nothing to a second drain, so a message is never sent twice', () => {
    const queue = createPendingQueue()
    queue.enqueue({ text: 'only once' })

    expect(queue.drain()).toEqual(['only once'])
    expect(queue.drain()).toEqual([])
  })

  it('gives back the most recent message when it is taken back, and forgets it', () => {
    const queue = createPendingQueue()
    queue.enqueue({ text: 'first' })
    queue.enqueue({ text: 'second' })

    expect(queue.takeBackLast()?.text).toBe('second')
    expect(textsOf(queue)).toEqual(['first'])
  })

  it('has nothing to give back once a drain has already taken the message', () => {
    const queue = createPendingQueue()
    queue.enqueue({ text: 'gone to the model' })
    queue.drain()

    expect(queue.takeBackLast()).toBeNull()
  })

  it('has nothing to give back from an empty queue', () => {
    expect(createPendingQueue().takeBackLast()).toBeNull()
  })

  it('drops everything when the conversation is replaced', () => {
    const queue = createPendingQueue()
    queue.enqueue({ text: 'meant for the old thread' })

    queue.clear()

    expect(textsOf(queue)).toEqual([])
    expect(queue.drain()).toEqual([])
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
    queue.settleTaken({ landed: ['two'] })
    expect(told).toBe(5)

    leave()
    queue.enqueue({ text: 'unheard' })
    expect(told).toBe(5)
  })

  it('stays quiet when a drain finds nothing, so an idle loop does not re-render the app', () => {
    const queue = createPendingQueue()
    let told = 0
    queue.subscribe(() => {
      told += 1
    })

    queue.drain()
    queue.drain()
    queue.settleTaken({ landed: ['nothing of ours'] })
    queue.clear()

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

  it('reads what landed off the tail of the log, not off the whole of it', () => {
    const events = log([
      { type: 'user-said', text: 'said long ago' },
      { type: 'assistant-said', parts: [{ type: 'text', text: 'answered' }] },
      { type: 'user-said', text: 'are' },
      { type: 'user-said', text: 'you?' },
    ])

    expect(trailingSaid(events)).toEqual(['are', 'you?'])
  })

  it('gives every queued message its own key, so two identical ones still render apart', () => {
    const queue = createPendingQueue()
    queue.enqueue({ text: 'same' })
    queue.enqueue({ text: 'same' })

    const [first, second] = queue.getSnapshot()
    expect(first?.id).not.toBe(second?.id)
  })
})
