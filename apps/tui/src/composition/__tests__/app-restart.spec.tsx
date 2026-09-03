import { toThreadId } from '@dltech/atlas-core'
import { EShellStatus, toShellId, type ShellSnapshot } from '@dltech/atlas-harness'
import { testRender } from '@opentui/react/test-utils'
import { describe, expect, it } from 'bun:test'
import React from 'react'

import { grammarsReady, settle, teardown } from '../../ui/markdown/__tests__/harness'
import { HEADING } from '../../ui/components/exit-guard'
import { App } from '../app'
import { fakeApp, scriptedModelPort } from './fake-app'

await grammarsReady()

const THREAD = toThreadId('opened-thread')

const WIDE = { width: 150, height: 40, exitOnCtrlC: false }

type Mounted = Awaited<ReturnType<typeof testRender>>

const appWith = () =>
  fakeApp({ model: scriptedModelPort({ script: { thinking: 'weighing it', reply: 'done' } }) })

const runningShell = (): ShellSnapshot => ({
  command: 'bun run dev',
  description: 'bun run dev',
  status: EShellStatus.Running,
  pid: 4242,
  startedAt: '2026-09-02T12:00:00.000Z',
  lastOutputAt: '2026-09-02T12:00:00.000Z',
  totalCharacters: 24,
  awaitingInput: false,
  shellId: toShellId('bash_1'),
})

async function opened(app: ReturnType<typeof appWith>, onRestart?: () => void): Promise<Mounted> {
  const setup = await testRender(
    <App
      app={app}
      opened={{ threadId: THREAD, events: [], turns: [], name: null, started: true }}
      {...(onRestart === undefined ? {} : { onRestart })}
    />,
    WIDE,
  )
  await setup.flush()
  await settle(250)
  await setup.flush()
  return setup
}

async function ran(setup: Mounted, typed: string): Promise<void> {
  await setup.mockInput.typeText(typed)
  await setup.flush()
  setup.mockInput.pressEnter()
  await setup.flush()
  await settle(250)
  await setup.flush()
}

describe('/restart', () => {
  it('is offered by the command menu where the launch wired a restart', async () => {
    const setup = await opened(appWith(), () => undefined)

    try {
      await setup.mockInput.typeText('/rest')
      await settle(60)
      await setup.flush()

      expect(setup.captureCharFrame()).toContain('rebuild from source and restart')
    } finally {
      await teardown(setup)
    }
  }, 60_000)

  it('stays out of the menu where no restart is wired', async () => {
    const setup = await opened(appWith())

    try {
      await setup.mockInput.typeText('/rest')
      await settle(60)
      await setup.flush()

      expect(setup.captureCharFrame()).not.toContain('restart')
    } finally {
      await teardown(setup)
    }
  }, 60_000)

  it('restarts through the handler the launch wired in', async () => {
    let restarts = 0
    const setup = await opened(appWith(), () => {
      restarts += 1
    })

    try {
      await ran(setup, '/restart')

      expect(restarts).toBe(1)
    } finally {
      await teardown(setup)
    }
  }, 60_000)

  it('asks before restarting over a running background shell', async () => {
    let restarts = 0
    const app = appWith()
    app.shells.place(runningShell(), THREAD)
    const setup = await opened(app, () => {
      restarts += 1
    })

    try {
      await ran(setup, '/restart')

      expect(setup.captureCharFrame()).toContain(HEADING)
      expect(restarts).toBe(0)

      setup.mockInput.pressEnter()
      await setup.flush()
      await settle(250)
      await setup.flush()

      expect(restarts).toBe(1)
    } finally {
      await teardown(setup)
    }
  }, 60_000)

  it('stays put when the guard is talked down', async () => {
    let restarts = 0
    const app = appWith()
    app.shells.place(runningShell(), THREAD)
    const setup = await opened(app, () => {
      restarts += 1
    })

    try {
      await ran(setup, '/restart')
      expect(setup.captureCharFrame()).toContain(HEADING)

      setup.mockInput.pressEscape()
      await setup.flush()
      await settle(250)
      await setup.flush()

      expect(restarts).toBe(0)
      expect(setup.captureCharFrame()).not.toContain(HEADING)
    } finally {
      await teardown(setup)
    }
  }, 60_000)
})
