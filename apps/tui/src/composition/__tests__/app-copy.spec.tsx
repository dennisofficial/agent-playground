import { describe, expect, it, mock } from 'bun:test'
import { act } from 'react'

const copies: string[] = []

void mock.module('../../ui/clipboard', () => ({
  copyToClipboard: (args: { text: string }) => {
    copies.push(args.text)
    return true
  },
}))

const { grammarsReady } = await import('../../ui/markdown/__tests__/harness')
const { open, until, REPLY, THINKING } = await import('./app-fixture')
const { fakeApp, scriptedModelPort } = await import('./fake-app')

await grammarsReady()

const WORD = 'derives'

describe('copying out of a live transcript', () => {
  it('copies the word under a double click and says so above the composer', async () => {
    copies.length = 0
    const mounted = await open({
      app: fakeApp({ model: scriptedModelPort({ script: { thinking: THINKING, reply: REPLY } }) }),
    })

    try {
      await mounted.typeText('what does the loop do')
      mounted.pressEnter()
      await until({
        holds: async () => (await mounted.nextFrame()).includes(WORD),
        within: 10_000,
      })

      const rows = (await mounted.frame()).split('\n')
      const row = rows.findIndex((line) => line.includes(WORD))
      const column = (rows[row] ?? '').indexOf(WORD) + 2

      await act(async () => {
        await mounted.mouse.doubleClick(column, row)
      })

      expect(copies.at(-1)).toBe(WORD)
      expect(await mounted.nextFrame()).toContain('copied')
    } finally {
      await mounted.done()
    }
  }, 60_000)
})
