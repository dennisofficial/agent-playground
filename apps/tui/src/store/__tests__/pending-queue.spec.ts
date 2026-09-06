import { describe, expect, it } from 'bun:test'

import { createPendingQueue } from '../pending-queue'
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

    expect(queue.drain().map((said) => said.text)).toEqual(['first', 'second'])
    expect(queue.drain()).toEqual([])
  })

  it('keeps showing what it handed over, so the message is never off the screen', () => {
    const queue = createPendingQueue()
    queue.enqueue({ text: 'first' })
    queue.drain()

    expect(textsOf(queue)).toEqual(['first'])
  })

  it('keeps offering what it handed over until the log shows the agent moved past it', () => {
    const queue = createPendingQueue()
    queue.enqueue({ text: 'first' })
    queue.drain()

    queue.settleTaken({ events: log([{ type: 'user-said', text: 'first' }]) })
    expect(textsOf(queue)).toEqual(['first'])

    queue.settleTaken({
      events: log([
        { type: 'user-said', text: 'first' },
        { type: 'assistant-said', parts: [{ type: 'text', text: 'on it' }] },
      ]),
    })
    expect(textsOf(queue)).toEqual([])
  })

  it('lets it go when the turn that carried it opened with a message of its own', () => {
    const queue = createPendingQueue()
    queue.enqueue({ text: 'queued' })
    queue.drain()

    queue.settleTaken({
      events: log([
        { type: 'user-said', text: 'queued' },
        { type: 'user-said', text: 'and this one' },
      ]),
    })

    expect(textsOf(queue)).toEqual([])
  })

  it('holds on when the read that came back does not have it yet', () => {
    const queue = createPendingQueue()
    queue.enqueue({ text: 'first' })
    queue.drain()

    queue.settleTaken({ events: log([]) })
    queue.settleTaken({ events: log([{ type: 'user-said', text: 'something else' }]) })

    expect(textsOf(queue)).toEqual(['first'])
  })

  it('reads the most recent matching run, so a repeated text does not settle early', () => {
    const queue = createPendingQueue()
    queue.enqueue({ text: 'ok' })
    queue.drain()

    queue.settleTaken({
      events: log([
        { type: 'user-said', text: 'ok' },
        { type: 'assistant-said', parts: [{ type: 'text', text: 'old answer' }] },
        { type: 'user-said', text: 'ok' },
      ]),
    })

    expect(textsOf(queue)).toEqual(['ok'])
  })

  it('shows what it handed over ahead of what is still waiting', () => {
    const queue = createPendingQueue()
    queue.enqueue({ text: 'taken' })
    queue.drain()
    queue.enqueue({ text: 'waiting' })

    expect(textsOf(queue)).toEqual(['taken', 'waiting'])

    queue.settleTaken({
      events: log([
        { type: 'user-said', text: 'taken' },
        { type: 'assistant-said', parts: [{ type: 'text', text: 'done' }] },
      ]),
    })
    expect(textsOf(queue)).toEqual(['waiting'])
  })

  it('returns nothing to a second drain, so a message is never sent twice', () => {
    const queue = createPendingQueue()
    queue.enqueue({ text: 'only once' })

    expect(queue.drain().map((said) => said.text)).toEqual(['only once'])
    expect(queue.drain()).toEqual([])
  })

  it('gives back the most recent message when it is taken back, and forgets it', () => {
    const queue = createPendingQueue()
    queue.enqueue({ text: 'first' })
    queue.enqueue({ text: 'second' })

    expect(queue.takeBackLast()?.text).toBe('second')
    expect(textsOf(queue)).toEqual(['first'])
  })

  it('gives a taken message back too, flagged so its log copy can be retracted', () => {
    const queue = createPendingQueue()
    queue.enqueue({ text: 'gone to the model' })
    queue.drain()

    const recalled = queue.takeBackLast()
    expect(recalled?.text).toBe('gone to the model')
    expect(recalled?.taken).toBe(true)
    expect(textsOf(queue)).toEqual([])
  })

  it('gives back what is still waiting before what was taken', () => {
    const queue = createPendingQueue()
    queue.enqueue({ text: 'taken' })
    queue.drain()
    queue.enqueue({ text: 'waiting' })

    expect(queue.takeBackLast()?.text).toBe('waiting')
    expect(textsOf(queue)).toEqual(['taken'])
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
    queue.settleTaken({
      events: log([
        { type: 'user-said', text: 'two' },
        { type: 'assistant-said', parts: [{ type: 'text', text: 'done' }] },
      ]),
    })
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
    queue.settleTaken({ events: log([{ type: 'user-said', text: 'nothing of ours' }]) })
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

  it('gives every queued message its own key, so two identical ones still render apart', () => {
    const queue = createPendingQueue()
    queue.enqueue({ text: 'same' })
    queue.enqueue({ text: 'same' })

    const [first, second] = queue.getSnapshot()
    expect(first?.id).not.toBe(second?.id)
  })
})
