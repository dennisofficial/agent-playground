import { toThreadId } from '@dltech/atlas-core'
import { EShellStatus, toShellId, type ShellSnapshot } from '@dltech/atlas-harness'
import { testRender } from '@opentui/react/test-utils'
import { describe, expect, it } from 'bun:test'
import React from 'react'

import { grammarsReady, settle, teardown } from '../../ui/markdown/__tests__/harness'
import { App } from '../app'
import { fakeApp, scriptedModelPort, type FakeApp } from './fake-app'

await grammarsReady()

const THREAD = toThreadId('opened-thread')

const WIDE = { width: 150, height: 40 }

const READ_MS = 60

const running = (over: { shellId: string; command: string }): ShellSnapshot => ({
  command: over.command,
  status: EShellStatus.Running,
  pid: 4242,
  startedAt: '2026-08-27T12:00:00.000Z',
  lastOutputAt: '2026-08-27T12:00:00.000Z',
  totalCharacters: 24,
  awaitingInput: false,
  shellId: toShellId(over.shellId),
})

const appWith = (shells: readonly ShellSnapshot[]): FakeApp => {
  const app = fakeApp({
    model: scriptedModelPort({ script: { thinking: 'weighing it', reply: 'done' } }),
  })
  for (const shell of shells) app.shells.place(shell)
  return app
}

type Mounted = Awaited<ReturnType<typeof testRender>>

async function opened(app: FakeApp): Promise<Mounted> {
  const setup = await testRender(
    <App app={app} opened={{ threadId: THREAD, events: [], name: null }} />,
    WIDE,
  )
  await setup.flush()
  await settle(250)
  await setup.flush()
  return setup
}

describe('reading a background shell without losing the sidebar', () => {
  it('lists the running shells in the sidebar it already has', async () => {
    const setup = await opened(appWith([running({ shellId: 'bash_1', command: 'bun run dev' })]))

    try {
      const frame = setup.captureCharFrame()

      expect(frame).toContain('SHELLS')
      expect(frame).toContain('bun run dev')
    } finally {
      await teardown(setup)
    }
  }, 60_000)

  it('opens the log over the transcript, leaving the sidebar list in place beside it', async () => {
    const setup = await opened(appWith([running({ shellId: 'bash_1', command: 'bun run dev' })]))

    try {
      setup.mockInput.pressKey('t', { ctrl: true })
      await settle(READ_MS)
      await setup.flush()

      const frame = setup.captureCharFrame()

      expect(frame).toContain('SHELL LOG')
      expect(frame).toContain('output of bash_1')
      expect(frame).toContain('SHELLS')
      expect(frame).toContain('esc')
    } finally {
      await teardown(setup)
    }
  }, 60_000)

  it('opens the log for the shell row that was clicked in the sidebar', async () => {
    const setup = await opened(appWith([running({ shellId: 'bash_1', command: 'bun run dev' })]))

    try {
      const rows = setup.captureCharFrame().split('\n')
      const row = rows.findIndex((line) => line.includes('bun run dev'))
      const column = (rows[row] ?? '').indexOf('bun run dev')

      expect(row).toBeGreaterThanOrEqual(0)

      await setup.mockMouse.click(column, row)
      await settle(READ_MS)
      await setup.flush()

      const frame = setup.captureCharFrame()

      expect(frame).toContain('SHELL LOG')
      expect(frame).toContain('output of bash_1')
    } finally {
      await teardown(setup)
    }
  }, 60_000)

  it('closes the log again and gives the transcript back', async () => {
    const setup = await opened(appWith([running({ shellId: 'bash_1', command: 'bun run dev' })]))

    try {
      setup.mockInput.pressKey('t', { ctrl: true })
      await settle(READ_MS)
      await setup.flush()
      expect(setup.captureCharFrame()).toContain('SHELL LOG')

      setup.mockInput.pressEscape()
      await settle(READ_MS)
      await setup.flush()

      expect(setup.captureCharFrame()).not.toContain('SHELL LOG')
    } finally {
      await teardown(setup)
    }
  }, 60_000)
})
