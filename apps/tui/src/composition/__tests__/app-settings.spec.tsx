import { ESettingId, toBranchId, type SettingsDocument } from '@dltech/atlas-core'
import { testRender } from '@opentui/react/test-utils'
import { describe, expect, it } from 'bun:test'
import React from 'react'

import { grammarsReady, settle, teardown } from '../../ui/markdown/__tests__/harness'
import { App } from '../app'
import { fakeApp, scriptedModelPort, type FakeApp } from './fake-app'

await grammarsReady()

const BRANCH = toBranchId('opened-branch')

const WIDE = { width: 150, height: 40 }

type Mounted = Awaited<ReturnType<typeof testRender>>

const appWith = (settings?: SettingsDocument): FakeApp =>
  fakeApp({
    model: scriptedModelPort({ script: { thinking: 'weighing it', reply: 'done' } }),
    ...(settings === undefined ? {} : { settings }),
  })

const widthOf = (sidebarWidth: number): SettingsDocument => ({
  values: { [ESettingId.SidebarWidth]: sidebarWidth },
})

const columnOf = (setup: Mounted, needle: string): number => {
  const row = setup
    .captureCharFrame()
    .split('\n')
    .find((line) => line.includes(needle))

  return row === undefined ? -1 : row.indexOf(needle)
}

const READ_MS = 60

async function landed(setup: Mounted): Promise<void> {
  await settle(READ_MS)
  await setup.flush()
}

async function opened(app: FakeApp): Promise<Mounted> {
  const setup = await testRender(<App app={app} opened={{ branchId: BRANCH, events: [], name: null }} />, WIDE)
  await setup.flush()
  await settle(250)
  await setup.flush()
  return setup
}

async function onSettings(app: FakeApp): Promise<Mounted> {
  const setup = await opened(app)
  setup.mockInput.pressKey('o', { ctrl: true })
  await landed(setup)
  return setup
}

const valueOf = (app: FakeApp, id: ESettingId): unknown =>
  app.settings.snapshot().resolution.settings.get(id)?.value

const SIDEBAR_WIDTH_ROW = 2

async function downTo(args: { setup: Mounted; row: number }): Promise<void> {
  for (let step = 0; step < args.row; step += 1) {
    args.setup.mockInput.pressArrow('down')
    await landed(args.setup)
  }
}

describe('the settings page', () => {
  it('stays closed until ctrl+o asks for it, and leaves on escape', async () => {
    const setup = await opened(appWith())

    try {
      expect(setup.captureCharFrame()).not.toContain('TRANSCRIPT')

      setup.mockInput.pressKey('o', { ctrl: true })
      await landed(setup)
      expect(setup.captureCharFrame()).toContain('TRANSCRIPT')

      setup.mockInput.pressEscape()
      await landed(setup)
      expect(setup.captureCharFrame()).not.toContain('TRANSCRIPT')
    } finally {
      await teardown(setup)
    }
  }, 60_000)

  it('toggles the row under the cursor on ⏎ and saves it', async () => {
    const app = appWith()
    const setup = await onSettings(app)

    try {
      expect(valueOf(app, ESettingId.SmoothStreaming)).toBe(true)

      setup.mockInput.pressEnter()
      await landed(setup)

      expect(valueOf(app, ESettingId.SmoothStreaming)).toBe(false)
      expect(app.settings.snapshot().document.values[ESettingId.SmoothStreaming]).toBe(false)
      expect(setup.captureCharFrame()).toContain('off')
    } finally {
      await teardown(setup)
    }
  }, 60_000)

  it('walks a range with the arrows without leaving its bounds', async () => {
    const app = appWith()
    const setup = await onSettings(app)

    try {
      await downTo({ setup, row: SIDEBAR_WIDTH_ROW })

      setup.mockInput.pressArrow('right')
      await landed(setup)
      expect(valueOf(app, ESettingId.SidebarWidth)).toBe(44)

      for (let step = 0; step < 12; step += 1) {
        setup.mockInput.pressArrow('right')
        await landed(setup)
      }

      expect(valueOf(app, ESettingId.SidebarWidth)).toBe(64)
    } finally {
      await teardown(setup)
    }
  }, 60_000)

  it('walks the tab strip to another page', async () => {
    const setup = await onSettings(appWith())

    try {
      expect(setup.captureCharFrame()).not.toContain('COLOUR')

      setup.mockInput.pressTab()
      await landed(setup)

      const frame = setup.captureCharFrame()
      expect(frame).toContain('COLOUR')
      expect(frame).toContain('Accent')

      setup.mockInput.pressTab({ shift: true })
      await landed(setup)
      expect(setup.captureCharFrame()).toContain('TRANSCRIPT')
    } finally {
      await teardown(setup)
    }
  }, 60_000)

  it('applies a saved setting to the app it came from', async () => {
    const app = appWith()
    const setup = await onSettings(app)

    try {
      await downTo({ setup, row: SIDEBAR_WIDTH_ROW })
      setup.mockInput.pressArrow('left')
      await landed(setup)

      setup.mockInput.pressEscape()
      await landed(setup)

      expect(valueOf(app, ESettingId.SidebarWidth)).toBe(40)
      expect(setup.captureCharFrame()).not.toContain('TRANSCRIPT')
    } finally {
      await teardown(setup)
    }
  }, 60_000)

  it('resizes the explanation pane as the width changes under the cursor', async () => {
    const app = appWith()
    const setup = await onSettings(app)

    try {
      await downTo({ setup, row: SIDEBAR_WIDTH_ROW })
      const before = columnOf(setup, 'SET BY')
      expect(before).toBeGreaterThan(0)

      setup.mockInput.pressArrow('right')
      await landed(setup)

      expect(valueOf(app, ESettingId.SidebarWidth)).toBe(44)
      expect(columnOf(setup, 'SET BY')).toBe(before - 2)
    } finally {
      await teardown(setup)
    }
  }, 60_000)

  it('gives the model picker the same width every other side pane gets', async () => {
    const columns: number[] = []

    for (const sidebarWidth of [42, 56]) {
      const setup = await opened(appWith(widthOf(sidebarWidth)))
      try {
        setup.mockInput.pressKey('p', { ctrl: true })
        await landed(setup)
        columns.push(columnOf(setup, 'MODEL'))
      } finally {
        await teardown(setup)
      }
    }

    expect(columns[0]).toBeGreaterThan(0)
    expect((columns[0] ?? 0) - (columns[1] ?? 0)).toBe(14)
  }, 60_000)

  it('keeps the keys to itself while it is open', async () => {
    const app = appWith()
    const setup = await onSettings(app)

    try {
      await setup.mockInput.typeText('hello')
      await landed(setup)

      expect(setup.captureCharFrame()).not.toContain('hello')
    } finally {
      await teardown(setup)
    }
  }, 60_000)
})
