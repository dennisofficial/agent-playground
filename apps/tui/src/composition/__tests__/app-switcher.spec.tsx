import {
  EEffort,
  ESettingId,
  parseFavourites,
  refKey,
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

const appWith = (args?: { pinned?: string }): FakeApp =>
  fakeApp({
    model: scriptedModelPort({ script: { thinking: 'weighing it', reply: 'done' } }),
    ...(args?.pinned === undefined
      ? {}
      : { settings: { values: { [ESettingId.ModelFavourites]: args.pinned } } }),
  })

const defaultIn = (app: FakeApp): string =>
  textValueOf({ resolution: app.settings.snapshot().resolution, id: ESettingId.ModelId })

const chosenIn = (app: FakeApp): readonly string[] =>
  app.threads.chosenModels.map((held) => held.model.ref)

const pinnedIn = (app: FakeApp): readonly string[] =>
  parseFavourites(
    textValueOf({
      resolution: app.settings.snapshot().resolution,
      id: ESettingId.ModelFavourites,
    }),
  )

async function pin(setup: Mounted): Promise<void> {
  setup.mockInput.typeText('*')
  await landed(setup)
}

async function opened(app: FakeApp): Promise<Awaited<ReturnType<typeof testRender>>> {
  const setup = await testRender(<App app={app} opened={{ threadId: THREAD, events: [], turns: [], name: null, started: true }} />, WIDE)
  await setup.flush()
  await settle(250)
  await setup.flush()
  return setup
}

type Mounted = Awaited<ReturnType<typeof testRender>>

/**
 * Mock input reaches the renderer through stdin, which resolves on a real tick rather than on the
 * frame — so a bare flush paints before the key has been read.
 */
const READ_MS = 60

async function landed(setup: Mounted): Promise<void> {
  await settle(READ_MS)
  await setup.flush()
}

async function openSwitcherWith(setup: Mounted): Promise<void> {
  setup.mockInput.pressKey('p', { ctrl: true })
  await landed(setup)
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

async function escape(setup: Mounted): Promise<void> {
  setup.mockInput.pressEscape()
  await landed(setup)
}

describe('switching what answers', () => {
  it('opens the switcher over the transcript on ctrl+p', async () => {
    const app = appWith()
    const setup = await opened(app)

    try {
      expect(setup.captureCharFrame()).not.toContain('APPLIES')

      await openSwitcherWith(setup)

      const frame = setup.captureCharFrame()
      expect(frame).toContain('MODEL')
      expect(frame).toContain('EFFORT')
      expect(frame).toContain('APPLIES')
    } finally {
      await teardown(setup)
    }
  }, 60_000)

  it('lands the pair on the harness, so the next turn runs on it', async () => {
    const app = appWith()
    const setup = await opened(app)

    try {
      expect(refKey(app.model.choice().ref)).toBe('anthropic/claude-haiku-4-5')

      await openSwitcherWith(setup)
      await arrow(setup, 'up')
      await arrow(setup, 'right')
      await enter(setup)

      expect(refKey(app.model.choice().ref)).toBe('anthropic/claude-sonnet-5')
      expect(app.model.choice().effort).toBe(EEffort.High)
      expect(setup.captureCharFrame()).not.toContain('APPLIES')
    } finally {
      await teardown(setup)
    }
  }, 60_000)

  it('says the footer answers on the model it was handed', async () => {
    const app = appWith()
    const setup = await opened(app)

    try {
      await openSwitcherWith(setup)
      await arrow(setup, 'up')
      await enter(setup)

      expect(setup.captureCharFrame()).toContain('sonnet-5')
    } finally {
      await teardown(setup)
    }
  }, 60_000)

  it('keeps what was answering when it is dismissed', async () => {
    const app = appWith()
    const setup = await opened(app)

    try {
      await openSwitcherWith(setup)
      await arrow(setup, 'up')
      await escape(setup)

      expect(refKey(app.model.choice().ref)).toBe('anthropic/claude-haiku-4-5')
      expect(setup.captureCharFrame()).not.toContain('APPLIES')
    } finally {
      await teardown(setup)
    }
  }, 60_000)

  it('swallows what is typed rather than letting it fall into the draft', async () => {
    const app = appWith()
    const setup = await opened(app)

    try {
      await openSwitcherWith(setup)
      await setup.mockInput.typeText('sonnet')
      await landed(setup)

      const frame = setup.captureCharFrame()
      expect(frame).toContain('APPLIES')
      expect(frame).not.toContain('┃  sonnet')
    } finally {
      await teardown(setup)
    }
  }, 60_000)

  it('narrows the list to what was typed, and switches to what is left', async () => {
    const app = appWith()
    const setup = await opened(app)

    try {
      await openSwitcherWith(setup)
      await setup.mockInput.typeText('opus')
      await landed(setup)

      const frame = setup.captureCharFrame()
      expect(frame).toContain('opus-5')
      expect(frame).not.toContain('sonnet-5')

      await enter(setup)

      expect(refKey(app.model.choice().ref)).toBe('anthropic/claude-opus-5')
    } finally {
      await teardown(setup)
    }
  }, 60_000)

  it('never lands on a model there is no credential for', async () => {
    const app = appWith()
    const setup = await opened(app)

    try {
      await openSwitcherWith(setup)
      for (let step = 0; step < 6; step += 1) await arrow(setup, 'down')
      await enter(setup)

      expect(app.model.choice().ref.providerId).not.toBe('openai')
    } finally {
      await teardown(setup)
    }
  }, 60_000)
})

describe('the two model preferences', () => {
  it('writes a pick onto the conversation, so another terminal keeps its own model', async () => {
    const app = appWith()
    const setup = await opened(app)

    try {
      await openSwitcherWith(setup)
      await arrow(setup, 'up')
      await enter(setup)

      expect(chosenIn(app)).toContain('anthropic/claude-sonnet-5')
      expect(defaultIn(app)).toBe('')
    } finally {
      await teardown(setup)
    }
  }, 60_000)

  it('says a pick lands on this conversation only', async () => {
    const app = appWith()
    const setup = await opened(app)

    try {
      await openSwitcherWith(setup)

      expect(setup.captureCharFrame()).toContain('this conversation only')
    } finally {
      await teardown(setup)
    }
  }, 60_000)

  it('opens on the conversation the thread was last switched to', async () => {
    const app = appWith()
    const setup = await testRender(
      <App
        app={app}
        opened={{
          threadId: THREAD,
          events: [],
          turns: [],
          name: null,
          started: true,
          model: { ref: 'anthropic/claude-opus-5', effort: EEffort.High },
        }}
      />,
      WIDE,
    )

    try {
      await setup.flush()
      await settle(250)
      await setup.flush()

      expect(refKey(app.model.choice().ref)).toBe('anthropic/claude-opus-5')
      expect(app.model.choice().effort).toBe(EEffort.High)
    } finally {
      await teardown(setup)
    }
  }, 60_000)

  it('sets the default from the settings row, leaving the conversation where it is', async () => {
    const app = appWith()
    const setup = await opened(app)

    try {
      await openSettingsWith(setup)
      await downTo({ setup, needle: 'Default model' })
      await enter(setup)

      expect(setup.captureCharFrame()).toContain('the default · every new conversatio')

      await arrow(setup, 'up')
      await enter(setup)

      expect(defaultIn(app)).toBe('anthropic/claude-sonnet-5')
      expect(refKey(app.model.choice().ref)).toBe('anthropic/claude-haiku-4-5')
      expect(chosenIn(app)).not.toContain('anthropic/claude-sonnet-5')
    } finally {
      await teardown(setup)
    }
  }, 60_000)
})

describe('pinning the models worth coming back to', () => {
  it('writes the pin where the next launch will read it', async () => {
    const app = appWith()
    const setup = await opened(app)

    try {
      expect(pinnedIn(app)).toEqual([])

      await openSwitcherWith(setup)
      await pin(setup)

      expect(pinnedIn(app)).toEqual(['anthropic/claude-haiku-4-5'])
    } finally {
      await teardown(setup)
    }
  }, 60_000)

  it('takes the pin back off the model it is already on', async () => {
    const app = appWith({ pinned: 'anthropic/claude-haiku-4-5' })
    const setup = await opened(app)

    try {
      await openSwitcherWith(setup)
      await pin(setup)

      expect(pinnedIn(app)).toEqual([])
    } finally {
      await teardown(setup)
    }
  }, 60_000)

  it('gathers what is pinned into a group above the providers', async () => {
    const app = appWith({ pinned: 'anthropic/claude-sonnet-5' })
    const setup = await opened(app)

    try {
      await openSwitcherWith(setup)

      const lines = setup.captureCharFrame().split('\n')
      const pinned = lines.findIndex((line) => line.includes('Pinned'))
      const plan = lines.findIndex((line) => line.includes('Claude Plan'))
      expect(pinned).toBeGreaterThan(0)
      expect(pinned).toBeLessThan(plan)
      expect(lines[pinned + 1]).toContain('sonnet-5')
    } finally {
      await teardown(setup)
    }
  }, 60_000)

  it('keeps the highlight on the model it just pinned, wherever that moved it', async () => {
    const app = appWith()
    const setup = await opened(app)

    try {
      await openSwitcherWith(setup)
      await pin(setup)
      await enter(setup)

      expect(refKey(app.model.choice().ref)).toBe('anthropic/claude-haiku-4-5')
    } finally {
      await teardown(setup)
    }
  }, 60_000)

  it('leaves the pin key out of the filter it types into', async () => {
    const app = appWith()
    const setup = await opened(app)

    try {
      await openSwitcherWith(setup)
      await pin(setup)

      expect(setup.captureCharFrame()).not.toContain('▸ *')
    } finally {
      await teardown(setup)
    }
  }, 60_000)
})

describe('unfolding what a row folded away', () => {
  it('opens the newest tool group on ⏎ with an empty draft', async () => {
    const app = appWith()
    const setup = await opened(app)

    try {
      setup.mockInput.typeText('go')
      await landed(setup)
      await enter(setup)
      await settle(400)
      await setup.flush()

      const before = setup.captureCharFrame()
      expect(before).toContain('Thinking…')

      await enter(setup)

      expect(setup.captureCharFrame()).toContain('weighing it')
    } finally {
      await teardown(setup)
    }
  }, 60_000)
})
