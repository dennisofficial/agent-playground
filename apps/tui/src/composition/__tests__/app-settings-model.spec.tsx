import {
  choiceValueOf,
  DEFAULT_EFFORT,
  EEffort,
  ESettingId,
  textValueOf,
  toThreadId,
} from '@dltech/atlas-core'
import { testRender } from '@opentui/react/test-utils'
import { describe, expect, it } from 'bun:test'
import React from 'react'

import { grammarsReady, settle, teardown } from '../../ui/markdown/__tests__/harness'
import { App } from '../app'
import { fakeApp, scriptedModelPort, type FakeApp } from './fake-app'

await grammarsReady()

const THREAD = toThreadId('opened-thread')

const WIDE = { width: 150, height: 40 }

const appWith = (args?: { effort?: string }): FakeApp =>
  fakeApp({
    model: scriptedModelPort({ script: { thinking: 'weighing it', reply: 'done' } }),
    ...(args?.effort === undefined
      ? {}
      : { settings: { values: { [ESettingId.ModelEffort]: args.effort } } }),
  })

type Mounted = Awaited<ReturnType<typeof testRender>>

const READ_MS = 60

const valueIn = (app: FakeApp, id: ESettingId): string =>
  textValueOf({ resolution: app.settings.snapshot().resolution, id })

const effortIn = (app: FakeApp): string =>
  choiceValueOf({
    resolution: app.settings.snapshot().resolution,
    id: ESettingId.ModelEffort,
    fallback: DEFAULT_EFFORT,
  })

const writtenFor = (app: FakeApp, id: ESettingId): unknown =>
  app.settings.snapshot().document.values[id]

async function opened(app: FakeApp): Promise<Mounted> {
  const setup = await testRender(
    <App app={app} opened={{ threadId: THREAD, events: [], turns: [], name: null, started: true }} />,
    WIDE,
  )
  await setup.flush()
  await settle(250)
  await setup.flush()
  return setup
}

async function landed(setup: Mounted): Promise<void> {
  await settle(READ_MS)
  await setup.flush()
}

async function openSettingsWith(setup: Mounted): Promise<void> {
  setup.mockInput.pressKey('o', { ctrl: true })
  await landed(setup)
}

async function downTo(args: { setup: Mounted; needle: string }): Promise<void> {
  for (let step = 0; step < 30; step += 1) {
    const row = args.setup
      .captureCharFrame()
      .split('\n')
      .find((line) => line.includes(args.needle))
    if (row !== undefined && row.includes('❯')) return

    args.setup.mockInput.pressArrow('down')
    await landed(args.setup)
  }

  throw new Error(`never reached the ${args.needle} row`)
}

async function arrow(setup: Mounted, direction: 'up' | 'down' | 'left' | 'right'): Promise<void> {
  setup.mockInput.pressArrow(direction)
  await landed(setup)
}

async function enter(setup: Mounted): Promise<void> {
  setup.mockInput.pressEnter()
  await landed(setup)
}

const rowShowing = (setup: Mounted, needle: string): string =>
  setup
    .captureCharFrame()
    .split('\n')
    .find((line) => line.includes(needle)) ?? ''

describe('the model-kind settings rows', () => {
  it('writes the picked model and effort to the Default model row that was activated', async () => {
    const app = appWith()
    const setup = await opened(app)

    try {
      await openSettingsWith(setup)
      await downTo({ setup, needle: 'Default model' })
      await enter(setup)

      expect(setup.captureCharFrame()).toContain('the default · every new conversatio')

      await arrow(setup, 'up')
      await arrow(setup, 'right')
      await enter(setup)

      expect(valueIn(app, ESettingId.ModelId)).toBe('anthropic/claude-sonnet-5')
      expect(effortIn(app)).toBe(EEffort.High)
      expect(writtenFor(app, ESettingId.QuickModel)).toBeUndefined()
    } finally {
      await teardown(setup)
    }
  }, 60_000)

  it('writes only the model ref when the Quick-call model row is activated', async () => {
    const app = appWith({ effort: 'high' })
    const setup = await opened(app)

    try {
      await openSettingsWith(setup)
      await downTo({ setup, needle: 'Quick-call model' })

      expect(rowShowing(setup, 'Quick-call model')).toContain('shipped default')

      await enter(setup)

      const picking = setup.captureCharFrame()
      expect(picking).toContain('QUICK-CALL MODEL')
      expect(picking).not.toContain('EFFORT')

      await arrow(setup, 'up')
      await arrow(setup, 'left')
      await enter(setup)

      expect(valueIn(app, ESettingId.QuickModel)).toBe('anthropic/claude-sonnet-5')
      expect(writtenFor(app, ESettingId.ModelId)).toBeUndefined()
      expect(writtenFor(app, ESettingId.ModelEffort)).toBe('high')
      expect(rowShowing(setup, 'Quick-call model')).toContain('anthropic/claude-sonnet-5')
    } finally {
      await teardown(setup)
    }
  }, 60_000)

  it('lets the search caret move with left and right, since no effort rides along', async () => {
    const app = appWith()
    const setup = await opened(app)

    try {
      await openSettingsWith(setup)
      await downTo({ setup, needle: 'Quick-call model' })
      await enter(setup)

      await setup.mockInput.typeText('sonnet')
      await landed(setup)
      await arrow(setup, 'left')
      await setup.mockInput.typeText('x')
      await landed(setup)

      expect(setup.captureCharFrame()).toContain('sonnext')
    } finally {
      await teardown(setup)
    }
  }, 60_000)
})
