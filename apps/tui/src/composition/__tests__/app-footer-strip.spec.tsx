import { parseColor } from '@opentui/core'
import { EShellStatus, toShellId, type ShellSnapshot } from '@dltech/atlas-harness'
import { testRender } from '@opentui/react/test-utils'
import { describe, expect, it } from 'bun:test'
import React from 'react'

import { grammarsReady, settle, teardown } from '../../ui/markdown/__tests__/harness'
import { theme } from '../../ui/theme'
import { App } from '../app'
import { spokenIn } from './app-fixture'
import { fakeApp, scriptedModelPort, type FakeApp } from './fake-app'

await grammarsReady()

const WIDE = { width: 150, height: 40 }

const PILL = '⏺ 1/1'

const SHELLS_OVERLAY = 'SHELL LOG'

const TOO_NARROW_FOR_A_PILL = 54

const running = (shellId: string): ShellSnapshot => ({
  command: 'bun run dev',
  description: 'bun run dev',
  status: EShellStatus.Running,
  pid: 4242,
  startedAt: '2026-08-27T12:00:00.000Z',
  lastOutputAt: '2026-08-27T12:00:00.000Z',
  totalCharacters: 24,
  awaitingInput: false,
  shellId: toShellId(shellId),
})

const appWithAShell = (): FakeApp => {
  const app = fakeApp({
    model: scriptedModelPort({ script: { thinking: 'weighing it', reply: 'done' } }),
  })
  app.shells.place(running('bash_1'))
  return app
}

type Mounted = Awaited<ReturnType<typeof testRender>>

async function opened(app: FakeApp): Promise<Mounted> {
  const setup = await testRender(<App app={app} opened={await spokenIn(app)} />, WIDE)
  await setup.flush()
  await settle(250)
  await setup.flush()
  return setup
}

const painted = async (setup: Mounted): Promise<void> => {
  await setup.flush()
  await settle(50)
  await setup.flush()
}

type Colour = { equals: (other: unknown) => boolean }

type Spans = { lines: ({ spans: { text: string; bg: Colour }[] } | undefined)[] }

const bandedPill = (setup: Mounted): boolean => {
  const rows = setup.captureCharFrame().split('\n')
  const row = rows.findIndex((line) => line.includes(PILL))
  if (row < 0) return false

  const cell = (rows[row] ?? '').indexOf(PILL)
  let column = 0
  for (const span of (setup.captureSpans() as unknown as Spans).lines[row]?.spans ?? []) {
    const width = [...span.text].length
    if (cell < column + width) return span.bg.equals(parseColor(theme.hover))
    column += width
  }
  return false
}

const draftShows = (setup: Mounted, text: string): boolean =>
  setup
    .captureCharFrame()
    .split('\n')
    .some((row) => row.includes(text))

describe('stepping into the row under the composer', () => {
  it('shows what is running there and bands it when Down reaches it', async () => {
    const setup = await opened(appWithAShell())

    try {
      expect(setup.captureCharFrame()).toContain(PILL)
      expect(bandedPill(setup)).toBe(false)

      setup.mockInput.pressArrow('down')
      await painted(setup)

      expect(bandedPill(setup)).toBe(true)
    } finally {
      await teardown(setup)
    }
  }, 30_000)

  it('leaves Down to the draft while there is a row of it below the caret', async () => {
    const setup = await opened(appWithAShell())

    try {
      await setup.mockInput.typeText('first line\nsecond line')
      await painted(setup)
      setup.mockInput.pressArrow('up')
      await setup.flush()

      setup.mockInput.pressArrow('down')
      await painted(setup)

      expect(bandedPill(setup)).toBe(false)
    } finally {
      await teardown(setup)
    }
  }, 30_000)

  it('opens what the selected pill names when Enter reaches it', async () => {
    const setup = await opened(appWithAShell())

    try {
      setup.mockInput.pressArrow('down')
      await painted(setup)
      expect(setup.captureCharFrame()).not.toContain(SHELLS_OVERLAY)

      setup.mockInput.pressEnter()
      await setup.flush()
      await settle(250)
      await painted(setup)

      expect(setup.captureCharFrame()).toContain(SHELLS_OVERLAY)
    } finally {
      await teardown(setup)
    }
  }, 30_000)

  it('lets go of a pill the terminal has got too narrow to draw', async () => {
    const setup = await opened(appWithAShell())

    try {
      setup.mockInput.pressArrow('down')
      await painted(setup)
      expect(bandedPill(setup)).toBe(true)

      setup.resize(TOO_NARROW_FOR_A_PILL, WIDE.height)
      await painted(setup)
      expect(setup.captureCharFrame()).not.toContain(PILL)
      expect(setup.captureCharFrame()).not.toContain(SHELLS_OVERLAY)

      setup.mockInput.pressEnter()
      await painted(setup)
      await settle(250)
      await setup.flush()

      expect(setup.captureCharFrame()).not.toContain(SHELLS_OVERLAY)
    } finally {
      await teardown(setup)
    }
  }, 30_000)

  it('hands the composer back on escape, and typing lands in the draft again', async () => {
    const setup = await opened(appWithAShell())

    try {
      setup.mockInput.pressArrow('down')
      await painted(setup)
      setup.mockInput.pressEscape()
      await painted(setup)

      expect(bandedPill(setup)).toBe(false)

      await setup.mockInput.typeText('back in the draft')
      await painted(setup)

      expect(draftShows(setup, 'back in the draft')).toBe(true)
    } finally {
      await teardown(setup)
    }
  }, 30_000)

  it('hands the composer back on up as well', async () => {
    const setup = await opened(appWithAShell())

    try {
      setup.mockInput.pressArrow('down')
      await painted(setup)
      setup.mockInput.pressArrow('up')
      await painted(setup)

      expect(bandedPill(setup)).toBe(false)
    } finally {
      await teardown(setup)
    }
  }, 30_000)

  it('is not a dead key: a letter typed in the row lands in the draft', async () => {
    const setup = await opened(appWithAShell())

    try {
      setup.mockInput.pressArrow('down')
      await painted(setup)
      await setup.mockInput.typeText('typed out')
      await painted(setup)

      expect(bandedPill(setup)).toBe(false)
      expect(draftShows(setup, 'typed out')).toBe(true)
    } finally {
      await teardown(setup)
    }
  }, 30_000)

  it('lets the command menu keep Down while it is walking its own list', async () => {
    const setup = await opened(appWithAShell())

    try {
      await setup.mockInput.typeText('/')
      await painted(setup)
      expect(setup.captureCharFrame()).toContain(PILL)

      setup.mockInput.pressArrow('down')
      await painted(setup)

      expect(setup.captureCharFrame()).toContain(PILL)
      expect(bandedPill(setup)).toBe(false)
    } finally {
      await teardown(setup)
    }
  }, 30_000)

  it('never enters from under an overlay that has already taken the keyboard', async () => {
    const setup = await opened(appWithAShell())

    try {
      setup.mockInput.pressKey('t', { ctrl: true })
      await setup.flush()
      await settle(250)
      await setup.flush()
      expect(setup.captureCharFrame()).toContain(SHELLS_OVERLAY)

      setup.mockInput.pressArrow('down')
      await painted(setup)
      setup.mockInput.pressEscape()
      await painted(setup)
      await settle(250)
      await painted(setup)

      expect(setup.captureCharFrame()).not.toContain(SHELLS_OVERLAY)
      expect(setup.captureCharFrame()).toContain(PILL)
      expect(bandedPill(setup)).toBe(false)
    } finally {
      await teardown(setup)
    }
  }, 30_000)

  it('does nothing observable, and leaves the draft alone, when there is no row to enter', async () => {
    const bare = fakeApp({
      model: scriptedModelPort({ script: { thinking: 'weighing it', reply: 'done' } }),
    })
    const setup = await opened(bare)

    try {
      await setup.mockInput.typeText('one\ntwo')
      await setup.flush()

      setup.mockInput.pressArrow('down')
      await painted(setup)

      expect(setup.captureCharFrame()).not.toContain('1/1')
      expect(draftShows(setup, 'one')).toBe(true)
      expect(draftShows(setup, 'two')).toBe(true)
    } finally {
      await teardown(setup)
    }
  }, 30_000)
})
