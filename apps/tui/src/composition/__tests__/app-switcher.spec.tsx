import { EEffort, toBranchId } from '@dltech/atlas-core'
import { testRender } from '@opentui/react/test-utils'
import { describe, expect, it } from 'bun:test'
import React from 'react'

import { grammarsReady, settle, teardown } from '../../ui/markdown/__tests__/harness'
import { App } from '../app'
import { fakeApp, scriptedModelPort, type FakeApp } from './fake-app'

await grammarsReady()

const BRANCH = toBranchId('opened-branch')

const WIDE = { width: 150, height: 40 }

const appWith = (): FakeApp =>
  fakeApp({ model: scriptedModelPort({ script: { thinking: 'weighing it', reply: 'done' } }) })

async function opened(app: FakeApp): Promise<Awaited<ReturnType<typeof testRender>>> {
  const setup = await testRender(<App app={app} opened={{ branchId: BRANCH, events: [] }} />, WIDE)
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
      expect(app.model.choice().modelId).toBe('claude-haiku-4-5-20251001')

      await openSwitcherWith(setup)
      await arrow(setup, 'up')
      await arrow(setup, 'right')
      await enter(setup)

      expect(app.model.choice().modelId).toBe('claude-sonnet-5')
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

      expect(app.model.choice().modelId).toBe('claude-haiku-4-5-20251001')
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

  it('never lands on a model there is no credential for', async () => {
    const app = appWith()
    const setup = await opened(app)

    try {
      await openSwitcherWith(setup)
      for (let step = 0; step < 6; step += 1) await arrow(setup, 'down')
      await enter(setup)

      expect(app.model.choice().modelId).not.toBe('gpt-5-codex')
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
