import { describe, expect, it } from 'bun:test'

import { grammarsReady } from '../../ui/markdown/__tests__/harness'
import { open, until, BRANCH, REPLY, THINKING } from './app-fixture'
import { FAKE_CONFIG, fakeApp, failingModelPort, scriptedModelPort } from './fake-app'

await grammarsReady()

const PROVIDER_ERROR = 'overloaded_error'

describe('the app you can actually open', () => {
  it('opens straight into a transcript, with no menu and no error on an empty branch', async () => {
    const mounted = await open({ app: fakeApp({ model: scriptedModelPort({ script: { thinking: THINKING, reply: REPLY } }) }) })

    try {
      const frame = await mounted.frame()
      expect(frame).toContain(FAKE_CONFIG.cwd)
      expect(frame).toContain('Describe the work')
      expect(frame).toContain('Ask anything')
    } finally {
      await mounted.done()
    }
  }, 60_000)

  it('shows what was typed, then streams the thinking and the reply back', async () => {
    const mounted = await open({
      app: fakeApp({ model: scriptedModelPort({ script: { thinking: THINKING, reply: REPLY } }) }),
    })

    try {
      await mounted.typeText('what derives the prompt')
      expect(await mounted.frame()).toContain('what derives the prompt')

      mounted.pressEnter()

      const answered = await until({
        holds: async () => {
          const frame = await mounted.frame()
          return frame.includes('derives every prompt') && frame.includes('what derives the prompt')
        },
        within: 20_000,
      })

      expect(answered).toBe(true)

      const events = await mounted.app.log.read({ branchId: BRANCH })
      expect(events.map((event) => event.type)).toEqual(['user-said', 'assistant-said'])
    } finally {
      await mounted.done()
    }
  }, 60_000)

  it('sends what the buffer holds when the text and ⏎ arrive in one burst', async () => {
    const mounted = await open({
      app: fakeApp({ model: scriptedModelPort({ script: { thinking: THINKING, reply: REPLY } }) }),
    })

    try {
      await mounted.typeText('pasted without a render in between')
      mounted.pressEnter()

      const said = await until({
        holds: async () => {
          await mounted.frame()
          const events = await mounted.app.log.read({ branchId: BRANCH })
          return events.some(
            (event) => event.type === 'user-said' && event.text.includes('without a render'),
          )
        },
        within: 20_000,
      })

      expect(said).toBe(true)
    } finally {
      await mounted.done()
    }
  }, 60_000)

  it('shows a working line on the first frame after sending, so a slow turn is not a hung one', async () => {
    const mounted = await open({
      app: fakeApp({
        model: scriptedModelPort({ script: { thinking: THINKING, reply: REPLY }, perChunkMs: 400 }),
      }),
    })

    try {
      await mounted.frame()

      await mounted.typeText('go')
      mounted.pressEnter()

      const first = await mounted.nextFrame()
      expect(first).toContain('Working for')
      expect(first).toContain('esc to interrupt')
    } finally {
      await mounted.done()
    }
  }, 60_000)

  it('leaves an interrupted reply in the transcript, marked', async () => {
    const mounted = await open({
      app: fakeApp({
        model: scriptedModelPort({
          script: { thinking: THINKING, reply: REPLY },
          perChunkMs: 300,
        }),
      }),
    })

    try {
      await mounted.typeText('go')
      mounted.pressEnter()

      const spoke = await until({
        holds: async () => (await mounted.frame()).includes('Atlas derives'),
        within: 30_000,
      })
      expect(spoke).toBe(true)

      mounted.pressEscape()

      const kept = await until({
        holds: async () => (await mounted.frame()).includes('Interrupted by you'),
        within: 20_000,
      })
      expect(kept).toBe(true)

      const events = await mounted.app.log.read({ branchId: BRANCH })
      const last = events.at(-1)
      expect(last?.type).toBe('assistant-said')
      expect(last?.type === 'assistant-said' ? last.interrupted : false).toBe(true)
    } finally {
      await mounted.done()
    }
  }, 60_000)

  it('names the model error rather than falling silent when the turn failed before any reply', async () => {
    const mounted = await open({
      app: fakeApp({ model: failingModelPort({ message: PROVIDER_ERROR }) }),
    })

    try {
      await mounted.typeText('what changed?')
      mounted.pressEnter()

      const blamed = await until({
        holds: async () => (await mounted.frame()).includes(PROVIDER_ERROR),
        within: 20_000,
      })

      expect(blamed).toBe(true)
      const frame = await mounted.frame()
      expect(frame).toContain('failed')
      expect(frame).not.toContain('The model reported no reason.')
    } finally {
      await mounted.done()
    }
  }, 60_000)
})
