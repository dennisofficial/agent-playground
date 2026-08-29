import { RESUME_NUDGE } from '@dltech/atlas-core'
import { describe, expect, it } from 'bun:test'

import { grammarsReady } from '../../ui/markdown/__tests__/harness'
import { open, until, THREAD, THINKING } from './app-fixture'
import { fakeApp, scriptedModelPort } from './fake-app'

await grammarsReady()

const MESSAGE = 'explain the loop'

const SPOKEN = 'The loop keeps its position in the log, so nothing has to remember it.'

const HEAD = 'The loop keeps'

const WORKING = 'esc to interrupt'

const RESUME_HINT = 'resume'

const typesOf = async (mounted: { app: { log: { read: (args: { threadId: typeof THREAD }) => Promise<readonly { type: string }[]> } } }) =>
  (await mounted.app.log.read({ threadId: THREAD })).map((event) => event.type)

async function stoppedMidReply() {
  const mounted = await open({
    app: fakeApp({
      model: scriptedModelPort({ script: { thinking: THINKING, reply: SPOKEN }, perChunkMs: 300 }),
    }),
  })

  await mounted.typeText(MESSAGE)
  mounted.pressEnter()

  const spoke = await until({
    holds: async () => (await mounted.frame()).includes(HEAD),
    within: 30_000,
  })
  expect(spoke).toBe(true)

  mounted.pressEscape()

  const idle = await until({
    holds: async () => !(await mounted.frame()).includes(WORKING),
    within: 20_000,
  })
  expect(idle).toBe(true)

  return mounted
}

describe('resuming a turn escape stopped', () => {
  it('offers the resume hint once the turn has stopped with the model holding the floor', async () => {
    const mounted = await stoppedMidReply()

    try {
      expect(await mounted.frame()).toContain(RESUME_HINT)
    } finally {
      await mounted.done()
    }
  }, 60_000)

  it('nudges the loop back into the same turn rather than asking the developer to type', async () => {
    const mounted = await stoppedMidReply()

    try {
      mounted.pressCtrl('r')

      const resumed = await until({
        holds: async () => {
          await mounted.frame()
          return (await typesOf(mounted)).includes('nudge')
        },
        within: 20_000,
      })
      expect(resumed).toBe(true)

      const events = await mounted.app.log.read({ threadId: THREAD })
      const nudge = events.find((event) => event.type === 'nudge')
      expect(nudge?.type === 'nudge' ? nudge.text : '').toBe(RESUME_NUDGE)
      expect(events.filter((event) => event.type === 'user-said')).toHaveLength(1)
    } finally {
      await mounted.done()
    }
  }, 60_000)

  it('shows no resume hint on a turn the model finished of its own accord', async () => {
    const mounted = await open({
      app: fakeApp({ model: scriptedModelPort({ script: { thinking: THINKING, reply: SPOKEN } }) }),
    })

    try {
      await mounted.typeText(MESSAGE)
      mounted.pressEnter()

      const settled = await until({
        holds: async () => {
          const frame = await mounted.frame()
          return frame.includes(HEAD) && !frame.includes(WORKING)
        },
        within: 30_000,
      })
      expect(settled).toBe(true)
      expect(await mounted.frame()).not.toContain(RESUME_HINT)
    } finally {
      await mounted.done()
    }
  }, 60_000)
})
