import { stampDrafts, toEventId, toRunId, type Event } from '@dltech/atlas-core'
import { ETurnStatus, type TurnSpend } from '@dltech/atlas-harness'
import { describe, expect, it } from 'bun:test'

import { grammarsReady } from '../../ui/markdown/__tests__/harness'
import type { OpenedConversation } from '../open-conversation'
import { open, until, REPLY, THINKING, THREAD } from './app-fixture'
import { fakeApp, scriptedModelPort } from './fake-app'

await grammarsReady()

const worked = (frame: string): number => frame.split('\n').filter((row) => row.includes('Worked for')).length

describe('the line a finished turn leaves behind', () => {
  it('stays where the turn ended when the next message is sent', async () => {
    const mounted = await open({
      app: fakeApp({ model: scriptedModelPort({ script: { thinking: THINKING, reply: REPLY } }) }),
    })

    try {
      await mounted.typeText('first')
      mounted.pressEnter()

      const settled = await until({
        holds: async () => worked(await mounted.frame()) === 1,
        within: 20_000,
      })
      expect(settled).toBe(true)

      await mounted.typeText('second')
      mounted.pressEnter()

      const both = await until({
        holds: async () => {
          const frame = await mounted.frame()
          return worked(frame) === 2 && frame.includes('first') && frame.includes('second')
        },
        within: 20_000,
      })

      expect(both).toBe(true)
    } finally {
      await mounted.done()
    }
  }, 60_000)

  it('sits below the reply it measured and above the message that follows', async () => {
    const mounted = await open({
      app: fakeApp({ model: scriptedModelPort({ script: { thinking: THINKING, reply: REPLY } }) }),
    })

    try {
      await mounted.typeText('first')
      mounted.pressEnter()

      await until({ holds: async () => worked(await mounted.frame()) === 1, within: 20_000 })

      await mounted.typeText('second')
      mounted.pressEnter()

      await until({
        holds: async () => (await mounted.frame()).includes('second'),
        within: 20_000,
      })

      const rows = (await mounted.frame()).split('\n')
      const line = rows.findIndex((row) => row.includes('Worked for'))
      const second = rows.findIndex((row) => row.includes('second'))

      expect(line).toBeGreaterThan(-1)
      expect(second).toBeGreaterThan(line)
    } finally {
      await mounted.done()
    }
  }, 60_000)
})

const YESTERDAY = toRunId('run-yesterday')

const AT = '2026-08-24T00:00:00.000Z'

const spoken: readonly Event[] = stampDrafts({
  drafts: [
    { type: 'user-said', text: 'how are you?' },
    { type: 'assistant-said', parts: [{ type: 'text', text: REPLY }] },
  ],
  envelopes: [0, 1].map((index) => ({
    id: toEventId(`event-${index + 1}`),
    seq: index + 1,
    threadId: THREAD,
    runId: YESTERDAY,
    depth: 0,
    at: AT,
  })),
})

const spent: TurnSpend = {
  runId: YESTERDAY,
  threadId: THREAD,
  status: ETurnStatus.Completed,
  providerId: 'anthropic',
  modelId: 'claude-opus-5',
  steps: 1,
  inputTokens: 1_000,
  outputTokens: 222,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  startedAt: AT,
  endedAt: '2026-08-24T00:00:03.000Z',
  durationMs: 3_000,
}

const reopened: OpenedConversation = {
  threadId: THREAD,
  events: spoken,
  turns: [spent],
  name: null,
}

describe('the line a turn left behind before the app was closed', () => {
  it('is drawn on the first frame, without waiting for a message to be sent', async () => {
    const mounted = await open({
      app: fakeApp({ model: scriptedModelPort({ script: { thinking: THINKING, reply: REPLY } }) }),
      opened: reopened,
    })

    try {
      expect(worked(await mounted.frame())).toBe(1)
    } finally {
      await mounted.done()
    }
  }, 60_000)
})
