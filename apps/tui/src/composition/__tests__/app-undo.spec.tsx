import { toCallId, toRunId } from '@dltech/atlas-core'
import { ETurnStatus } from '@dltech/atlas-harness'
import { describe, expect, it } from 'bun:test'

import { grammarsReady } from '../../ui/markdown/__tests__/harness'
import { open, until, THREAD, THINKING } from './app-fixture'
import { fakeApp, scriptedModelPort, type FakeApp } from './fake-app'

await grammarsReady()

const MESSAGE = 'undo this one'

const SPOKEN = 'The loop keeps its position in the log, so nothing has to remember it.'

const PROMPT = 'Ask anything'

const WORKING = 'esc to interrupt'

const CALL = 'write_file'

const REFUSED = 'dispatched but unsettled'

async function strandedCall(): Promise<FakeApp> {
  const app = fakeApp({ model: scriptedModelPort({ script: { thinking: THINKING, reply: SPOKEN } }) })

  await app.log.append({
    threadId: THREAD,
    runId: toRunId('run-before'),
    drafts: [{ type: 'tool-called', callId: toCallId('call-1'), name: CALL, input: {}, ordinal: 0 }],
  })

  return {
    ...app,
    runner: {
      say: app.runner.say,
      runTurn: async () => ({
        status: ETurnStatus.Interrupted,
        runId: toRunId('run-interrupted'),
        committed: false,
      }),
    },
  }
}

describe('escape on a turn that committed nothing', () => {
  it('empties the thread of the exchange and hands the message back to the composer', async () => {
    const mounted = await open({
      app: fakeApp({
        model: scriptedModelPort({ script: { thinking: THINKING, reply: SPOKEN }, perChunkMs: 200 }),
      }),
    })

    try {
      await mounted.typeText(MESSAGE)
      mounted.pressEnter()

      const reasoning = await until({
        holds: async () => (await mounted.frame()).includes('Thinking'),
        within: 20_000,
      })
      expect(reasoning).toBe(true)

      mounted.pressEscape()

      const emptied = await until({
        holds: async () => {
          await mounted.frame()
          return (await mounted.app.log.read({ threadId: THREAD })).length === 0
        },
        within: 20_000,
      })
      expect(emptied).toBe(true)

      const frame = await mounted.frame()
      expect(frame).toContain(MESSAGE)
      expect(frame).not.toContain(PROMPT)
      expect(frame).not.toContain('Thinking')
      expect(frame).toContain('Describe the work')
    } finally {
      await mounted.done()
    }
  }, 60_000)

  it('leaves the log alone once the model has spoken, and keeps the composer empty', async () => {
    const mounted = await open({
      app: fakeApp({
        model: scriptedModelPort({ script: { thinking: THINKING, reply: SPOKEN }, perChunkMs: 300 }),
      }),
    })

    try {
      await mounted.typeText(MESSAGE)
      mounted.pressEnter()

      const spoke = await until({
        holds: async () => (await mounted.frame()).includes('The loop keeps'),
        within: 30_000,
      })
      expect(spoke).toBe(true)

      mounted.pressEscape()

      const idle = await until({
        holds: async () => !(await mounted.frame()).includes(WORKING),
        within: 20_000,
      })
      expect(idle).toBe(true)

      const events = await mounted.app.log.read({ threadId: THREAD })
      expect(events.map((event) => event.type)).toEqual(['user-said', 'assistant-said'])
      expect(events[0]?.type === 'user-said' ? events[0].text : '').toBe(MESSAGE)
      expect(await mounted.frame()).toContain(PROMPT)
    } finally {
      await mounted.done()
    }
  }, 60_000)

  it('says why when the rewind is refused, rather than stopping and looking undone', async () => {
    const mounted = await open({ app: await strandedCall() })

    try {
      await mounted.typeText(MESSAGE)
      mounted.pressEnter()

      const blamed = await until({
        holds: async () => (await mounted.frame()).replace(/\s+/g, ' ').includes(REFUSED),
        within: 20_000,
      })

      expect(blamed).toBe(true)
      expect((await mounted.app.log.read({ threadId: THREAD })).length).toBe(2)
    } finally {
      await mounted.done()
    }
  }, 60_000)
})
