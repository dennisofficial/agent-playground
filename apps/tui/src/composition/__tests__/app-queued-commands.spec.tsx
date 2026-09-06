import { describe, expect, it } from 'bun:test'

import { grammarsReady } from '../../ui/markdown/__tests__/harness'
import { open, until, THREAD, REPLY, THINKING } from './app-fixture'
import { fakeApp, scriptedModelPort } from './fake-app'

await grammarsReady()

const slowly = () =>
  fakeApp({ model: scriptedModelPort({ script: { thinking: THINKING, reply: REPLY }, perChunkMs: 300 }) })

const STEER = 'check the tests too'

describe('a settled command typed mid-turn', () => {
  it('waits in the queue as a row, then runs when the turn settles', async () => {
    const mounted = await open({ app: slowly() })

    try {
      await mounted.typeText('start')
      mounted.pressEnter()

      const running = await until({
        holds: async () => (await mounted.frame()).includes('esc to interrupt'),
        within: 20_000,
      })
      expect(running).toBe(true)

      await mounted.typeText('/new')
      mounted.pressEnter()

      const queued = await until({
        holds: async () => (await mounted.frame()).includes('/new — runs when the turn finishes'),
        within: 20_000,
      })
      expect(queued).toBe(true)

      const swapped = await until({
        holds: async () => (await mounted.frame()).includes('Ask anything'),
        within: 20_000,
      })
      expect(swapped).toBe(true)
    } finally {
      await mounted.done()
    }
  }, 60_000)

  it('lets a message steer past a queued command, and keeps both with their thread', async () => {
    const mounted = await open({ app: slowly() })

    try {
      await mounted.typeText('start')
      mounted.pressEnter()

      const running = await until({
        holds: async () => (await mounted.frame()).includes('esc to interrupt'),
        within: 20_000,
      })
      expect(running).toBe(true)

      await mounted.typeText('/new')
      mounted.pressEnter()

      const queued = await until({
        holds: async () => (await mounted.frame()).includes('/new — runs when the turn finishes'),
        within: 20_000,
      })
      expect(queued).toBe(true)

      await mounted.typeText(STEER)
      mounted.pressEnter()

      const steered = await until({
        holds: async () => {
          const events = await mounted.app.log.read({ threadId: THREAD })
          return events.some((event) => event.type === 'user-said' && event.text === STEER)
        },
        within: 20_000,
      })
      expect(steered).toBe(true)

      const swapped = await until({
        holds: async () => (await mounted.frame()).includes('Ask anything'),
        within: 20_000,
      })
      expect(swapped).toBe(true)

      const events = await mounted.app.log.read({ threadId: THREAD })
      const said = events.filter((event) => event.type === 'user-said').map((event) => event.text)
      expect(said).toEqual(['start', STEER])
    } finally {
      await mounted.done()
    }
  }, 60_000)
})
