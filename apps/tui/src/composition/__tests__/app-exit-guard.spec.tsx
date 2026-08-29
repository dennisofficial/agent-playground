import { toThreadId } from '@dltech/atlas-core'
import { EShellStatus, toShellId, type ShellSnapshot } from '@dltech/atlas-harness'
import { testRender } from '@opentui/react/test-utils'
import { describe, expect, it } from 'bun:test'
import React from 'react'

import { HEADING, SUBTITLE } from '../../ui/components/exit-guard'
import { grammarsReady, settle, teardown } from '../../ui/markdown/__tests__/harness'
import { App } from '../app'
import { fakeApp, scriptedModelPort, type FakeApp } from './fake-app'

await grammarsReady()

const THREAD = toThreadId('opened-thread')

/**
 * OpenTUI's renderer quits on ctrl+c by default (`exitOnCtrlC`), and the app turns that off in
 * boot.tsx — which a test mount never runs. Left on, the renderer tears down before the binding
 * under test is ever consulted.
 */
const WIDE = { width: 150, height: 40, exitOnCtrlC: false }

const PRESS_MS = 60

const PAST_SHELL_POLL_MS = 700

const MARKER = '❯'

const SCRIPTED_REPLY = 'the model answered'

const PLACEHOLDER = 'Describe the work below.'

const shell = (over: {
  shellId: string
  command: string
  description?: string
  status?: EShellStatus
}): ShellSnapshot => ({
  command: over.command,
  description: over.description,
  status: over.status ?? EShellStatus.Running,
  pid: 4242,
  startedAt: '2026-08-27T12:00:00.000Z',
  lastOutputAt: '2026-08-27T12:00:00.000Z',
  totalCharacters: 24,
  awaitingInput: false,
  shellId: toShellId(over.shellId),
})

const appWith = (shells: readonly ShellSnapshot[]): FakeApp => {
  const app = fakeApp({
    model: scriptedModelPort({ script: { thinking: 'weighing it', reply: SCRIPTED_REPLY } }),
  })
  for (const entry of shells) app.shells.place(entry)
  return app
}

type Mounted = Awaited<ReturnType<typeof testRender>>

/**
 * The fake registry hands back the very array it mutates, so a status changed in place is
 * invisible to the snapshot comparison that decides whether to re-render. Swapping the listing
 * for a fresh array is what makes a shell look like it ended.
 */
function endingShell(args: { app: FakeApp; running: ShellSnapshot }): () => void {
  let listed: readonly ShellSnapshot[] = [args.running]
  args.app.shells.list = () => listed

  return () => {
    listed = [{ ...args.running, status: EShellStatus.Exited }]
  }
}

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

async function quit(setup: Mounted): Promise<string> {
  setup.mockInput.pressKey('c', { ctrl: true })
  await settle(PRESS_MS)
  await setup.flush()
  return setup.captureCharFrame()
}

describe('quitting while a background shell is still running', () => {
  it('asks before it goes, naming the work that would stop', async () => {
    const setup = await opened(
      appWith([shell({ shellId: 'bash_1', command: 'bun test', description: 'Wait for TUI suite' })]),
    )

    try {
      const frame = await quit(setup)

      expect(frame).toContain(HEADING)
      expect(frame).toContain(SUBTITLE)
      expect(frame).toContain('Wait for TUI suite')
    } finally {
      await teardown(setup)
    }
  }, 60_000)

  it('offers stopping and staying, and shows moving to the background as not yet built', async () => {
    const setup = await opened(appWith([shell({ shellId: 'bash_1', command: 'bun run dev' })]))

    try {
      const frame = await quit(setup)

      expect(frame).toContain('Exit and stop tasks')
      expect(frame).toContain('Move to background and exit')
      expect(frame).toContain('coming soon')
      expect(frame).toContain('Stay')
    } finally {
      await teardown(setup)
    }
  }, 60_000)

  it('leaves a shell that has already ended out of the reckoning', async () => {
    const setup = await opened(
      appWith([shell({ shellId: 'bash_1', command: 'bun test', status: EShellStatus.Exited })]),
    )

    try {
      const frame = await quit(setup)

      expect(frame).not.toContain(HEADING)
    } finally {
      await teardown(setup)
    }
  }, 60_000)

  it('takes esc as a change of heart and puts the composer back', async () => {
    const setup = await opened(appWith([shell({ shellId: 'bash_1', command: 'bun run dev' })]))

    try {
      expect(await quit(setup)).toContain(HEADING)

      setup.mockInput.pressEscape()
      await settle(PRESS_MS)
      await setup.flush()

      expect(setup.captureCharFrame()).not.toContain(HEADING)
    } finally {
      await teardown(setup)
    }
  }, 60_000)

  it('steps past the option it cannot honour yet rather than letting it be chosen', async () => {
    const setup = await opened(appWith([shell({ shellId: 'bash_1', command: 'bun run dev' })]))

    try {
      await quit(setup)

      setup.mockInput.pressArrow('down')
      await settle(PRESS_MS)
      await setup.flush()

      const rows = setup.captureCharFrame().split('\n')
      const marked = rows.find((row) => row.includes(MARKER))

      expect(marked).toBeDefined()
      expect(marked).toContain('Stay')
    } finally {
      await teardown(setup)
    }
  }, 60_000)

  it('stands down on its own when the last shell finishes under it, without quitting', async () => {
    const live = shell({ shellId: 'bash_1', command: 'bun run dev' })
    const app = appWith([live])
    const end = endingShell({ app, running: live })
    const setup = await opened(app)

    try {
      expect(await quit(setup)).toContain(HEADING)

      end()
      await settle(PAST_SHELL_POLL_MS)
      await setup.flush()

      const frame = setup.captureCharFrame()

      expect(frame).not.toContain(HEADING)
      expect(frame).toContain(PLACEHOLDER)
    } finally {
      await teardown(setup)
    }
  }, 60_000)

  it('holds a shell ending back rather than starting a turn behind the prompt', async () => {
    const app = appWith([shell({ shellId: 'bash_1', command: 'bun run dev' })])
    const setup = await opened(app)

    try {
      expect(await quit(setup)).toContain(HEADING)

      app.shells.announce(
        shell({ shellId: 'bash_2', command: 'bun test', status: EShellStatus.Exited }),
      )
      await settle(PAST_SHELL_POLL_MS)
      await setup.flush()

      const frame = setup.captureCharFrame()

      expect(frame).toContain(HEADING)
      expect(frame).not.toContain(SCRIPTED_REPLY)
    } finally {
      await teardown(setup)
    }
  }, 60_000)

  it('closes on staying, leaving the conversation where it was', async () => {
    const setup = await opened(appWith([shell({ shellId: 'bash_1', command: 'bun run dev' })]))

    try {
      await quit(setup)

      setup.mockInput.pressArrow('down')
      await settle(PRESS_MS)
      setup.mockInput.pressEnter()
      await settle(PRESS_MS)
      await setup.flush()

      expect(setup.captureCharFrame()).not.toContain(HEADING)
    } finally {
      await teardown(setup)
    }
  }, 60_000)
})
