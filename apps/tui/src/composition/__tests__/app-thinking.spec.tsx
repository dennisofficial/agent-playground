import { ESettingId } from '@dltech/atlas-core'
import { describe, expect, it } from 'bun:test'

import { grammarsReady } from '../../ui/markdown/__tests__/harness'
import { EThinkingVisibility } from '../../store'
import { open, until, THREAD, REPLY, THINKING } from './app-fixture'
import { fakeApp, scriptedModelPort } from './fake-app'

await grammarsReady()

const appThinking = (visibility: EThinkingVisibility) =>
  fakeApp({
    model: scriptedModelPort({ script: { thinking: THINKING, reply: REPLY }, perChunkMs: 120 }),
    settings: { values: { [ESettingId.ThinkingBlocks]: visibility } },
  })

const answered = (mounted: Awaited<ReturnType<typeof open>>) =>
  until({
    holds: async () => (await mounted.frame()).includes('derives every prompt'),
    within: 20_000,
  })

describe('the thinking blocks setting', () => {
  it('leaves a summary row behind when it is set to keep', async () => {
    const mounted = await open({ app: appThinking(EThinkingVisibility.Keep) })

    try {
      await mounted.typeText('what derives the prompt')
      mounted.pressEnter()

      expect(await answered(mounted)).toBe(true)
      expect(await mounted.frame()).toContain('Thinking…')
    } finally {
      await mounted.done()
    }
  }, 60_000)

  it('drops the row once the thought is done when it is set to stream', async () => {
    const mounted = await open({ app: appThinking(EThinkingVisibility.Stream) })

    try {
      await mounted.typeText('what derives the prompt')
      mounted.pressEnter()

      expect(await answered(mounted)).toBe(true)
      expect(await mounted.frame()).not.toContain('Thinking…')

      const kept = await until({
        holds: async () => {
          await mounted.frame()
          const events = await mounted.app.log.read({ threadId: THREAD })
          return events.some(
            (event) =>
              event.type === 'assistant-said' &&
              event.parts.some((part) => part.type === 'reasoning'),
          )
        },
        within: 20_000,
      })

      expect(kept).toBe(true)
    } finally {
      await mounted.done()
    }
  }, 60_000)

  it('never renders a thought at all when it is set to hidden', async () => {
    const mounted = await open({ app: appThinking(EThinkingVisibility.Hidden) })

    try {
      await mounted.typeText('what derives the prompt')
      mounted.pressEnter()

      const seen: string[] = []
      const done = await until({
        holds: async () => {
          const frame = await mounted.frame()
          seen.push(frame)
          return frame.includes('derives every prompt')
        },
        within: 20_000,
      })

      expect(done).toBe(true)
      expect(seen.length).toBeGreaterThan(2)
      expect(seen.filter((frame) => frame.includes('Thinking…'))).toEqual([])
    } finally {
      await mounted.done()
    }
  }, 60_000)
})
