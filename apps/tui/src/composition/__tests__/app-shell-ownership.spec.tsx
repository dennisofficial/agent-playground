import { toRunId, toThreadId } from '@dltech/atlas-core'
import { EShellStatus, toShellId, type ShellSnapshot } from '@dltech/atlas-harness'
import { testRender } from '@opentui/react/test-utils'
import { describe, expect, it } from 'bun:test'
import React from 'react'

import { grammarsReady, settle, teardown } from '../../ui/markdown/__tests__/harness'
import { HEADING } from '../../ui/components/exit-guard'
import { App } from '../app'
import { spokenIn } from './app-fixture'
import { FAKE_CONFIG, fakeApp, scriptedModelPort, type FakeApp } from './fake-app'

await grammarsReady()

const THREAD = toThreadId('opened-thread')

const OTHER = toThreadId('made-1')

/**
 * OpenTUI's renderer quits on ctrl+c by default and the app turns that off in boot.tsx, which a
 * test mount never runs. Left on, it tears down before the exit guard is ever consulted.
 */
const WIDE = { width: 150, height: 40, exitOnCtrlC: false }

type Mounted = Awaited<ReturnType<typeof testRender>>

const running = (over: {
  shellId: string
  command: string
  description?: string
}): ShellSnapshot => ({
  command: over.command,
  description: over.description ?? over.command,
  status: EShellStatus.Running,
  pid: 4242,
  startedAt: '2026-08-27T12:00:00.000Z',
  lastOutputAt: '2026-08-27T12:00:00.000Z',
  totalCharacters: 24,
  awaitingInput: false,
  shellId: toShellId(over.shellId),
})

const appWith = (): FakeApp =>
  fakeApp({ model: scriptedModelPort({ script: { thinking: 'weighing it', reply: 'done' } }) })

async function seedOtherThread(app: FakeApp): Promise<void> {
  const thread = await app.threads.create({ workspace: FAKE_CONFIG.cwd, repo: null })
  await app.threads.rename({ threadId: thread.id, title: 'the other conversation' })
  await app.log.append({
    threadId: thread.id,
    runId: toRunId('run-other'),
    drafts: [{ type: 'user-said', text: 'over here' }],
  })
}

async function opened(app: FakeApp): Promise<Mounted> {
  const setup = await testRender(<App app={app} opened={await spokenIn(app)} />, WIDE)
  await setup.flush()
  await settle(250)
  await setup.flush()
  return setup
}

async function resumeTheOther(setup: Mounted): Promise<void> {
  await setup.mockInput.typeText('/resume')
  await setup.flush()
  setup.mockInput.pressEnter()
  await setup.flush()
  await settle(250)
  await setup.flush()
  setup.mockInput.pressEnter()
  await setup.flush()
  await settle(400)
  await setup.flush()
}

describe('a background shell belongs to the conversation that started it', () => {
  it('shows the starting conversation its own shell', async () => {
    const app = appWith()
    app.shells.place(running({ shellId: 'bash_1', command: 'bun run dev' }), THREAD)
    const setup = await opened(app)

    try {
      expect(setup.captureCharFrame()).toContain('bun run dev')
    } finally {
      await teardown(setup)
    }
  }, 60_000)

  it('does not show it to a conversation that did not start it', async () => {
    const app = appWith()
    await seedOtherThread(app)
    app.shells.place(running({ shellId: 'bash_1', command: 'bun run dev' }), THREAD)
    const setup = await opened(app)

    try {
      expect(setup.captureCharFrame()).toContain('bun run dev')

      await resumeTheOther(setup)

      const frame = setup.captureCharFrame()
      expect(frame).toContain('over here')
      expect(frame).not.toContain('bun run dev')
    } finally {
      await teardown(setup)
    }
  }, 60_000)

  it('still names it on the way out, because quitting kills it whoever started it', async () => {
    const app = appWith()
    await seedOtherThread(app)
    app.shells.place(running({ shellId: 'bash_1', command: 'bun run dev' }), THREAD)
    const setup = await opened(app)

    try {
      await resumeTheOther(setup)
      expect(setup.captureCharFrame()).not.toContain('bun run dev')

      setup.mockInput.pressKey('c', { ctrl: true })
      await setup.flush()
      await settle(200)
      await setup.flush()

      const frame = setup.captureCharFrame()
      expect(frame).toContain(HEADING)
      expect(frame).toContain('bun run dev')
    } finally {
      await teardown(setup)
    }
  }, 60_000)

  it('keeps an ending for its owner rather than dropping it on a switch', async () => {
    const app = appWith()
    await seedOtherThread(app)
    app.shells.announce(
      { ...running({ shellId: 'bash_1', command: 'bun run dev' }), status: EShellStatus.Exited },
      OTHER,
    )
    const setup = await opened(app)

    try {
      expect(app.shells.threadsAwaitingNotice()).toEqual([OTHER])
      expect(app.shells.pendingNotices({ threadId: THREAD })).toEqual([])

      await resumeTheOther(setup)

      expect(app.shells.pendingNotices({ threadId: OTHER }).length).toBe(1)
    } finally {
      await teardown(setup)
    }
  }, 60_000)
})
