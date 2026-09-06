import { RESUME_NUDGE, toRunId, type EventDraft } from '@dltech/atlas-core'
import { describe, expect, it } from 'bun:test'

import { grammarsReady } from '../../ui/markdown/__tests__/harness'
import { EOpenMode } from '../config'
import type { OpenedConversation } from '../open-conversation'
import { open, until, THREAD, THINKING } from './app-fixture'
import { fakeApp, scriptedModelPort, type FakeApp } from './fake-app'

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

  const offered = await until({
    holds: async () => (await mounted.frame()).includes(RESUME_HINT),
    within: 20_000,
  })
  expect(offered).toBe(true)

  return mounted
}

async function reopenedWith(
  app: FakeApp,
  drafts: readonly EventDraft[],
): Promise<OpenedConversation> {
  const events = await app.log.append({
    threadId: THREAD,
    runId: toRunId('run-before'),
    drafts,
  })

  return { threadId: THREAD, events, turns: [], name: null, started: true }
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

describe('resuming on launch', () => {
  it('picks an interrupted turn back up without waiting for the chord', async () => {
    const app = fakeApp({
      model: scriptedModelPort({ script: { thinking: THINKING, reply: SPOKEN } }),
      open: { mode: EOpenMode.Continue },
    })
    const mounted = await open({
      app,
      opened: await reopenedWith(app, [
        { type: 'user-said', text: MESSAGE },
        { type: 'assistant-said', parts: [{ type: 'text', text: HEAD }], interrupted: true },
      ]),
    })

    try {
      const resumed = await until({
        holds: async () => (await typesOf(mounted)).includes('nudge'),
        within: 20_000,
      })
      expect(resumed).toBe(true)
      expect(mounted.app.turnsDriven).toBe(1)

      const events = await mounted.app.log.read({ threadId: THREAD })
      const nudge = events.find((event) => event.type === 'nudge')
      expect(nudge?.type === 'nudge' ? nudge.text : '').toBe(RESUME_NUDGE)
      expect(events.filter((event) => event.type === 'user-said')).toHaveLength(1)
    } finally {
      await mounted.done()
    }
  }, 60_000)

  it('runs a turn the last session never answered', async () => {
    const app = fakeApp({
      model: scriptedModelPort({ script: { thinking: THINKING, reply: SPOKEN } }),
      open: { mode: EOpenMode.Resume, threadId: THREAD },
    })
    const mounted = await open({
      app,
      opened: await reopenedWith(app, [{ type: 'user-said', text: MESSAGE }]),
    })

    try {
      const answered = await until({
        holds: async () => (await mounted.frame()).includes(HEAD),
        within: 30_000,
      })
      expect(answered).toBe(true)
      expect(mounted.app.turnsDriven).toBe(1)
      expect(await typesOf(mounted)).not.toContain('nudge')
    } finally {
      await mounted.done()
    }
  }, 60_000)

  it('leaves a settled thread alone', async () => {
    const app = fakeApp({
      model: scriptedModelPort({ script: { thinking: THINKING, reply: SPOKEN } }),
      open: { mode: EOpenMode.Continue },
    })
    const mounted = await open({
      app,
      opened: await reopenedWith(app, [
        { type: 'user-said', text: MESSAGE },
        { type: 'assistant-said', parts: [{ type: 'text', text: SPOKEN }] },
      ]),
    })

    try {
      await mounted.frame()
      expect(mounted.app.turnsDriven).toBe(0)
    } finally {
      await mounted.done()
    }
  }, 60_000)

  it('leaves a resumable thread alone when the launch opened a new conversation', async () => {
    const app = fakeApp({
      model: scriptedModelPort({ script: { thinking: THINKING, reply: SPOKEN } }),
    })
    const mounted = await open({
      app,
      opened: await reopenedWith(app, [{ type: 'user-said', text: MESSAGE }]),
    })

    try {
      await mounted.frame()
      expect(mounted.app.turnsDriven).toBe(0)
    } finally {
      await mounted.done()
    }
  }, 60_000)
})
