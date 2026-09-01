import { EAgentStatus, toRunId, toThreadId } from '@dltech/atlas-core'
import type { AgentSnapshot } from '@dltech/atlas-harness'
import { testRender } from '@opentui/react/test-utils'
import { describe, expect, it } from 'bun:test'
import React, { act } from 'react'

import { grammarsReady, settle, teardown } from '../../ui/markdown/__tests__/harness'
import { App } from '../app'
import { fakeApp, scriptedModelPort, type FakeApp } from './fake-app'
import { fakeAgentSnapshot } from './fake-agents'

await grammarsReady()

const THREAD = toThreadId('opened-thread')

const WIDE = { width: 150, height: 40, exitOnCtrlC: false }

type Mounted = Awaited<ReturnType<typeof testRender>>

const LONG_AGO = '2020-01-01T00:00:00.000Z'

const CHILD_SAID = 'The vault reads its key file exactly once.'

const appWith = (): FakeApp =>
  fakeApp({ model: scriptedModelPort({ script: { thinking: 'weighing it', reply: 'done' } }) })

const settled = (args: {
  agentId: string
  intent: string
  status?: EAgentStatus
  deliveredAt?: string | undefined
}): AgentSnapshot => ({
  ...fakeAgentSnapshot({
    agentId: args.agentId,
    intent: args.intent,
    status: args.status ?? EAgentStatus.Finished,
    toolCalls: 3,
  }),
  endedAt: LONG_AGO,
  deliveredAt: args.deliveredAt,
})

async function opened(app: FakeApp): Promise<Mounted> {
  const events = await app.log.append({
    threadId: THREAD,
    runId: toRunId('run-before'),
    drafts: [{ type: 'user-said', text: 'what is in here?' }],
  })
  const setup = await testRender(
    <App app={app} opened={{ threadId: THREAD, events, turns: [], name: null, started: true }} />,
    WIDE,
  )
  await setup.flush()
  await settle(250)
  await setup.flush()
  return setup
}

describe('a settled sub-agent leaving the sidebar', () => {
  it('holds a finished child whose result the parent has not read', async () => {
    const app = appWith()
    const setup = await opened(app)

    try {
      act(() => app.agents.place(settled({ agentId: 'thr_undelivered', intent: 'pending audit' })))
      await setup.flush()

      expect(setup.captureCharFrame()).toContain('pending audit')
    } finally {
      await teardown(setup)
    }
  }, 60_000)

  it('takes the whole heading with it once every child has been read and retired', async () => {
    const app = appWith()
    const setup = await opened(app)

    try {
      act(() =>
        app.agents.place(
          settled({ agentId: 'thr_read', intent: 'consumed audit', deliveredAt: LONG_AGO }),
        ),
      )
      await setup.flush()

      const frame = setup.captureCharFrame()
      expect(frame).not.toContain('consumed audit')
      expect(frame).not.toContain('SUBAGENTS')
    } finally {
      await teardown(setup)
    }
  }, 60_000)

  it('counts what it let go of against the total, beside the rows it kept', async () => {
    const app = appWith()
    const setup = await opened(app)

    try {
      act(() => {
        app.agents.place(settled({ agentId: 'thr_held', intent: 'pending audit' }))
        app.agents.place(
          settled({ agentId: 'thr_gone', intent: 'consumed audit', deliveredAt: LONG_AGO }),
        )
      })
      await setup.flush()

      const frame = setup.captureCharFrame()
      expect(frame).toContain('pending audit')
      expect(frame).not.toContain('consumed audit')
      expect(frame).toContain('SUBAGENTS  0/2')
      expect(frame).toContain('1 more in /agents')
    } finally {
      await teardown(setup)
    }
  }, 60_000)

  it('still walks to a child the panel has let go of, because only the row retired', async () => {
    const app = appWith()
    await app.log.append({
      threadId: toThreadId('thr_gone'),
      runId: toRunId('run-child'),
      drafts: [{ type: 'assistant-said', parts: [{ type: 'text', text: CHILD_SAID }] }],
    })
    const setup = await opened(app)

    try {
      act(() =>
        app.agents.place(
          settled({ agentId: 'thr_gone', intent: 'consumed audit', deliveredAt: LONG_AGO }),
        ),
      )
      await setup.flush()
      expect(setup.captureCharFrame()).not.toContain('consumed audit')

      setup.mockInput.pressKey('g', { ctrl: true })
      await setup.flush()
      await settle(250)
      await setup.flush()

      expect(setup.captureCharFrame()).toContain(CHILD_SAID)
    } finally {
      await teardown(setup)
    }
  }, 60_000)

  it('never reclaims a failure the operator has not opened', async () => {
    const app = appWith()
    const setup = await opened(app)

    try {
      act(() =>
        app.agents.place(
          settled({
            agentId: 'thr_failed',
            intent: 'broken audit',
            status: EAgentStatus.Failed,
            deliveredAt: LONG_AGO,
          }),
        ),
      )
      await setup.flush()

      expect(setup.captureCharFrame()).toContain('broken audit')
    } finally {
      await teardown(setup)
    }
  }, 60_000)

  it('keeps a running child while its settled siblings retire around it', async () => {
    const app = appWith()
    const setup = await opened(app)

    try {
      act(() => {
        app.agents.place(fakeAgentSnapshot({ agentId: 'thr_live', intent: 'live audit' }))
        app.agents.place(
          settled({ agentId: 'thr_gone', intent: 'consumed audit', deliveredAt: LONG_AGO }),
        )
      })
      await setup.flush()

      const frame = setup.captureCharFrame()
      expect(frame).toContain('live audit')
      expect(frame).not.toContain('consumed audit')
      expect(frame).toContain('SUBAGENTS  1/2')
    } finally {
      await teardown(setup)
    }
  }, 60_000)
})
