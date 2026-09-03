import { EAgentStatus } from '@dltech/atlas-core'
import { describe, expect, it } from 'bun:test'

import { grammarsReady } from '../../ui/markdown/__tests__/harness'
import { glyph } from '../../ui/theme'
import { open, until, REPLY, THINKING } from './app-fixture'
import { fakeAgentSnapshot } from './fake-agents'
import { fakeApp, scriptedModelPort, type FakeApp } from './fake-app'

await grammarsReady()

const WAIT_MS = 20_000

const INTENT = 'audit the vault'

const NAMED = `Sub-agent explore "${INTENT}"`

const script = { thinking: THINKING, reply: REPLY }

const slowly = (): FakeApp => fakeApp({ model: scriptedModelPort({ script, perChunkMs: 300 }) })

const child = (agentId: string) =>
  fakeAgentSnapshot({ agentId, intent: INTENT, turns: 2, toolCalls: 5 })

async function busyWith(app: FakeApp) {
  const mounted = await open({ app })
  await mounted.typeText('start')
  mounted.pressEnter()

  const running = await until({
    holds: async () => (await mounted.frame()).includes('esc to interrupt'),
    within: WAIT_MS,
  })
  expect(running).toBe(true)

  return mounted
}

describe('a sub-agent that ends while the parent is mid-turn', () => {
  it('waits in the transcript as a queued notice, rather than vanishing until the turn is over', async () => {
    const mounted = await busyWith(slowly())

    try {
      mounted.app.agents.place(child('thread-child'))
      mounted.app.agents.end({ agentId: 'thread-child' })

      const shown = await until({
        holds: async () => (await mounted.frame()).includes(NAMED),
        within: WAIT_MS,
      })

      expect(shown).toBe(true)

      const rows = (await mounted.frame()).split('\n')
      const working = rows.findIndex((row) => row.includes('esc to interrupt'))
      const notice = rows.findIndex((row) => row.includes(NAMED))

      expect(notice).toBeGreaterThan(working)
      expect(rows[notice]).toContain(glyph.block)
      expect(rows[notice]).not.toContain('queued')
    } finally {
      await mounted.done()
    }
  }, 40_000)

  it('carries no take-back affordance, because nobody typed it', async () => {
    const mounted = await busyWith(slowly())

    try {
      mounted.app.agents.place(child('thread-child'))
      mounted.app.agents.end({ agentId: 'thread-child' })

      const shown = await until({
        holds: async () => (await mounted.frame()).includes(NAMED),
        within: WAIT_MS,
      })

      expect(shown).toBe(true)
      expect(await mounted.frame()).not.toContain('↑ to edit')
    } finally {
      await mounted.done()
    }
  }, 40_000)

  it('says a child failed rather than announcing it like one that answered', async () => {
    const mounted = await busyWith(slowly())

    try {
      mounted.app.agents.place(child('thread-child'))
      mounted.app.agents.end({ agentId: 'thread-child', status: EAgentStatus.Failed })

      const shown = await until({
        holds: async () => (await mounted.frame()).includes(`${NAMED} failed after`),
        within: WAIT_MS,
      })

      expect(shown).toBe(true)
    } finally {
      await mounted.done()
    }
  }, 40_000)
})
