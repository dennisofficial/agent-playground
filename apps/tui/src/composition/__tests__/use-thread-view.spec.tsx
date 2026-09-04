import { toRunId, toThreadId, type Event, type EventDraft } from '@dltech/atlas-core'
import { testRender } from '@opentui/react/test-utils'
import { describe, expect, it } from 'bun:test'
import React from 'react'

import { SHIPPED_THINKING } from '../../store'
import { settle, teardown } from '../../ui/markdown/__tests__/harness'
import { EThreadRows, useThreadView } from '../use-thread-view'
import { until } from './app-fixture'
import { fakeApp, scriptedModelPort, type FakeApp } from './fake-app'

const THREAD = toThreadId('thread-view-churn')

const RENDER_MS = 60

type Probe = { renders: number; reads: number; entries: number }

function ThreadViewProbe(props: { app: FakeApp; probe: Probe }): React.ReactNode {
  const view = useThreadView({
    app: props.app,
    threadId: THREAD,
    rows: EThreadRows.Own,
    thinking: SHIPPED_THINKING,
    readClock: () => 0,
    afterRead: () => {
      props.probe.reads += 1
    },
  })
  props.probe.renders += 1
  props.probe.entries = view.model.entries.length

  return <text>{`${view.model.entries.length} entries`}</text>
}

const append = (args: { app: FakeApp; drafts: readonly EventDraft[] }): Promise<Event[]> =>
  args.app.log.append({ threadId: THREAD, runId: toRunId('run-1'), drafts: args.drafts })

const readsPast = async (args: { probe: Probe; count: number }): Promise<void> => {
  const seen = await until({ holds: async () => args.probe.reads >= args.count, within: 5_000 })
  if (!seen) throw new Error(`the view never read the log a ${args.count}th time`)
}

describe('a thread view told the log moved', () => {
  it('re-reads without re-rendering when nothing came back new', async () => {
    const app = fakeApp({ model: scriptedModelPort({ script: { thinking: '', reply: 'ok' } }) })
    await append({ app, drafts: [{ type: 'user-said', text: 'hello' }] })

    const probe: Probe = { renders: 0, reads: 0, entries: 0 }
    const setup = await testRender(<ThreadViewProbe app={app} probe={probe} />, {
      width: 60,
      height: 6,
    })

    try {
      await readsPast({ probe, count: 1 })
      await settle(RENDER_MS)
      await setup.flush()

      const settled = probe.renders

      app.channel.publisherFor({ threadId: THREAD }).settleAppend({ events: [] })
      await readsPast({ probe, count: 2 })
      await settle(RENDER_MS)
      await setup.flush()

      expect(probe.renders).toBe(settled)

      await append({
        app,
        drafts: [{ type: 'assistant-said', parts: [{ type: 'text', text: 'answered' }] }],
      })
      app.channel.publisherFor({ threadId: THREAD }).settleAppend({ events: [] })
      await readsPast({ probe, count: 3 })
      await settle(RENDER_MS)
      await setup.flush()

      expect(probe.entries).toBe(2)
      expect(probe.renders).toBeGreaterThan(settled)
    } finally {
      await teardown(setup)
    }
  }, 30_000)
})
