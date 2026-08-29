import { describe, expect, it } from 'bun:test'

import { grammarsReady } from '../../ui/markdown/__tests__/harness'
import { open, until, THREAD, REPLY, THINKING } from './app-fixture'
import { fakeApp, scriptedModelPort } from './fake-app'

await grammarsReady()

const STEER = 'check the tests too'

const TAKE_BACK = '↑ to edit'

const script = { thinking: THINKING, reply: REPLY }

const slowly = () => fakeApp({ model: scriptedModelPort({ script, perChunkMs: 300 }) })

const promptly = () => fakeApp({ model: scriptedModelPort({ script }) })

describe('typing while the turn is running', () => {
  it('holds a message sent mid-turn in the queue, out of the log and out of the transcript', async () => {
    const mounted = await open({ app: slowly() })

    try {
      await mounted.typeText('start')
      mounted.pressEnter()

      const running = await until({
        holds: async () => (await mounted.frame()).includes('esc to interrupt'),
        within: 20_000,
      })
      expect(running).toBe(true)
      expect(await mounted.frame()).toContain('Steer the turn')

      await mounted.typeText(STEER)
      mounted.pressEnter()

      const queued = await until({
        holds: async () => {
          const frame = await mounted.frame()
          return frame.includes(STEER) && frame.includes(TAKE_BACK)
        },
        within: 20_000,
      })

      expect(queued).toBe(true)
      expect(mounted.app.turnsDriven).toBe(1)
      expect(mounted.app.pending.getSnapshot().map((message) => message.text)).toEqual([STEER])

      const midTurn = await mounted.app.log.read({ threadId: THREAD })
      expect(midTurn.filter((event) => event.type === 'user-said').length).toBe(1)
    } finally {
      await mounted.done()
    }
  }, 60_000)

  it('gives the most recent queued message back to the composer on ↑, and forgets it', async () => {
    const mounted = await open({ app: slowly() })

    try {
      await mounted.typeText('start')
      mounted.pressEnter()

      const running = await until({
        holds: async () => (await mounted.frame()).includes('esc to interrupt'),
        within: 20_000,
      })
      expect(running).toBe(true)

      await mounted.typeText(STEER)
      mounted.pressEnter()

      const queued = await until({
        holds: async () => (await mounted.frame()).includes(TAKE_BACK),
        within: 20_000,
      })
      expect(queued).toBe(true)

      mounted.pressUp()

      const returned = await until({
        holds: async () => {
          const frame = await mounted.frame()
          return frame.includes(STEER) && !frame.includes(TAKE_BACK)
        },
        within: 20_000,
      })

      expect(returned).toBe(true)
      expect(mounted.app.pending.getSnapshot()).toEqual([])
    } finally {
      await mounted.done()
    }
  }, 60_000)

  it('has nothing to give back on ↑ once the loop has already taken the message', async () => {
    const mounted = await open({ app: slowly() })

    try {
      await mounted.typeText('start')
      mounted.pressEnter()

      const running = await until({
        holds: async () => (await mounted.frame()).includes('esc to interrupt'),
        within: 20_000,
      })
      expect(running).toBe(true)

      await mounted.typeText(STEER)
      mounted.pressEnter()

      const queued = await until({
        holds: async () => (await mounted.frame()).includes(TAKE_BACK),
        within: 20_000,
      })
      expect(queued).toBe(true)

      expect(mounted.app.pending.drain()).toEqual([STEER])

      mounted.pressUp()
      await mounted.frame()

      expect(mounted.app.pending.takeBackLast()).toBeNull()
      expect(await mounted.frame()).not.toContain(TAKE_BACK)
    } finally {
      await mounted.done()
    }
  }, 60_000)

  it('never blanks the message between the loop taking it and the transcript showing it', async () => {
    const mounted = await open({ app: slowly() })

    try {
      await mounted.typeText('start')
      mounted.pressEnter()

      const running = await until({
        holds: async () => (await mounted.frame()).includes('esc to interrupt'),
        within: 20_000,
      })
      expect(running).toBe(true)

      await mounted.typeText(STEER)
      mounted.pressEnter()

      const queued = await until({
        holds: async () => (await mounted.frame()).includes(TAKE_BACK),
        within: 20_000,
      })
      expect(queued).toBe(true)

      let blanked = 0
      const shown = await until({
        holds: async () => {
          const frame = await mounted.frame()
          if (!frame.includes(STEER)) blanked += 1
          const events = await mounted.app.log.read({ threadId: THREAD })
          const landed = events.some((event) => event.type === 'user-said' && event.text === STEER)
          return landed && frame.includes(STEER) && !frame.includes(TAKE_BACK)
        },
        within: 20_000,
      })

      expect(shown).toBe(true)
      expect(blanked).toBe(0)
    } finally {
      await mounted.done()
    }
  }, 60_000)

  it('moves a queued message into the transcript when the loop drains it', async () => {
    const mounted = await open({ app: slowly() })

    try {
      await mounted.typeText('start')
      mounted.pressEnter()

      const running = await until({
        holds: async () => (await mounted.frame()).includes('esc to interrupt'),
        within: 20_000,
      })
      expect(running).toBe(true)

      await mounted.typeText(STEER)
      mounted.pressEnter()

      const consumed = await until({
        holds: async () => {
          await mounted.frame()
          const events = await mounted.app.log.read({ threadId: THREAD })
          return events.some((event) => event.type === 'user-said' && event.text === STEER)
        },
        within: 20_000,
      })

      expect(consumed).toBe(true)
      expect(mounted.app.turnsDriven).toBe(1)

      const released = await until({
        holds: async () => {
          await mounted.frame()
          return mounted.app.pending.getSnapshot().length === 0
        },
        within: 20_000,
      })
      expect(released).toBe(true)

      const events = await mounted.app.log.read({ threadId: THREAD })
      const kinds = events.map((event) => event.type)
      expect(kinds.indexOf('assistant-said')).toBeLessThan(kinds.lastIndexOf('user-said'))
    } finally {
      await mounted.done()
    }
  }, 60_000)

  it('drives exactly one turn for a message sent while idle, however many land after it', async () => {
    const mounted = await open({ app: promptly() })

    try {
      await mounted.typeText('what derives the prompt')
      mounted.pressEnter()

      const answered = await until({
        holds: async () => (await mounted.frame()).includes('derives every prompt'),
        within: 20_000,
      })
      expect(answered).toBe(true)
      expect(mounted.app.turnsDriven).toBe(1)

      await mounted.typeText('and again')
      mounted.pressEnter()

      const drivenTwice = await until({
        holds: async () => {
          await mounted.frame()
          return mounted.app.turnsDriven === 2
        },
        within: 20_000,
      })
      expect(drivenTwice).toBe(true)
    } finally {
      await mounted.done()
    }
  }, 60_000)
})
