import { toThreadId } from '@dltech/atlas-core'
import { testRender } from '@opentui/react/test-utils'
import { afterEach, describe, expect, it } from 'bun:test'
import React from 'react'

import { UNMEASURED_CONTEXT } from '../../ui/footer-layout'
import { currentNotice, dismissNotice } from '../../ui/notice-store'
import { grammarsReady, settle, teardown } from '../../ui/markdown/__tests__/harness'
import { App } from '../app'
import { fakeApp, scriptedModelPort, type FakeApp } from './fake-app'

await grammarsReady()

const THREAD = toThreadId('opened-thread')

const WIDE = { width: 150, height: 40 }

const appWith = (): FakeApp =>
  fakeApp({ model: scriptedModelPort({ script: { thinking: 'weighing it', reply: 'done' } }) })

const withNoCard = (app: FakeApp): FakeApp => ({
  ...app,
  models: { ...app.models, cardFor: () => undefined },
})

async function mounted(app: FakeApp): Promise<Awaited<ReturnType<typeof testRender>>> {
  const setup = await testRender(
    <App
      app={app}
      opened={{ threadId: THREAD, events: [], turns: [], name: null, started: true }}
    />,
    WIDE,
  )
  await setup.flush()
  await settle(250)
  await setup.flush()
  return setup
}

afterEach(() => {
  dismissNotice()
})

describe('launching on a model with no card', () => {
  it('says out loud that auto-compact stopped, rather than reading zero in silence', async () => {
    const setup = await mounted(withNoCard(appWith()))

    try {
      expect(currentNotice()?.text).toContain('Auto-compact and the context meter are off')
    } finally {
      await teardown(setup)
    }
  }, 60_000)

  it('marks the meter slot unknown rather than leaving it blank or reading zero', async () => {
    const setup = await mounted(withNoCard(appWith()))

    try {
      const frame = setup.captureCharFrame()
      expect(frame).toContain(UNMEASURED_CONTEXT)
      expect(frame).not.toContain('0 ctx')
      expect(frame).not.toContain('0%')
    } finally {
      await teardown(setup)
    }
  }, 60_000)

  it('stays quiet on an ordinary launch', async () => {
    const setup = await mounted(appWith())

    try {
      expect(currentNotice()?.text ?? '').not.toContain('Auto-compact')
    } finally {
      await teardown(setup)
    }
  }, 60_000)
})
