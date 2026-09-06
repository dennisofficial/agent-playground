import { ESettingId, toThreadId } from '@dltech/atlas-core'
import { testRender } from '@opentui/react/test-utils'
import { describe, expect, it } from 'bun:test'
import React from 'react'

import { accentHex } from '../../ui/accents'
import { appearanceOf, applyAppearance } from '../../ui/appearance'
import { grammarsReady, settle, teardown } from '../../ui/markdown/__tests__/harness'
import { resetPalette } from '../../ui/palette-store'
import { INK_MS, LIFT_MS, SETTLE_MS } from '../../ui/startup-model'
import { theme } from '../../ui/theme'
import { createBootProgress, EBootStep } from '../boot-progress'
import { BootScreen } from '../boot-screen'
import { ESession, type Session } from '../open-session'
import { fakeApp, scriptedModelPort, type FakeApp } from './fake-app'

await grammarsReady()

const WIDTH = 120

const HEIGHT = 32

const CWD = '/Users/dennis/Developer/atlas'

const THREAD = toThreadId('opened-thread')

const WORKSPACE = 'Describe the work'

const CURTAIN_MS = INK_MS + SETTLE_MS + LIFT_MS

const POLL_MS = 30

type Mounted = Awaited<ReturnType<typeof testRender>>

const appWith = (accent?: string): FakeApp =>
  fakeApp({
    model: scriptedModelPort({ script: { thinking: 'weighing it', reply: 'done' } }),
    ...(accent === undefined ? {} : { settings: { values: { [ESettingId.Accent]: accent } } }),
  })

const ready = (app: FakeApp): Session => ({
  type: ESession.Ready,
  app,
  opened: { threadId: THREAD, events: [], turns: [], name: null, started: true },
  credentialNotice: null,
})

async function mount(session: Promise<Session>, onAbandon = (): void => undefined): Promise<Mounted> {
  const progress = createBootProgress()
  progress.report(EBootStep.Opening)

  return testRender(
    <BootScreen session={session} progress={progress} cwd={CWD} onAbandon={onAbandon} />,
    { width: WIDTH, height: HEIGHT },
  )
}

async function framesUntilLifted(setup: Mounted): Promise<string[]> {
  const frames: string[] = []
  const deadline = Date.now() + CURTAIN_MS * 4

  while (Date.now() < deadline) {
    await setup.flush()
    const frame = setup.captureCharFrame()
    frames.push(frame)
    if (frame.includes(WORKSPACE)) return frames
    await settle(POLL_MS)
  }

  return frames
}

describe('the startup curtain over a booting harness', () => {
  it('fills the terminal while the harness is still starting', async () => {
    const setup = await mount(new Promise<Session>(() => undefined))

    try {
      await setup.flush()
      await settle(INK_MS)
      await setup.flush()

      const frame = setup.captureCharFrame()
      expect(frame).toContain('Developer/atlas')
      expect(frame).toContain('opening the conversation')
      expect(frame).not.toContain(WORKSPACE)
    } finally {
      await teardown(setup)
    }
  }, 60_000)

  it('cannot be hurried off a harness that is not there yet', async () => {
    const setup = await mount(new Promise<Session>(() => undefined))

    try {
      await setup.flush()
      setup.mockInput.pressKey('j')
      await settle(INK_MS + SETTLE_MS + LIFT_MS)
      await setup.flush()

      expect(setup.captureCharFrame()).toContain('opening the conversation')
    } finally {
      await teardown(setup)
    }
  }, 60_000)

  it('lets ctrl+c abandon a boot that has not finished', async () => {
    let abandoned = 0
    const setup = await mount(new Promise<Session>(() => undefined), () => {
      abandoned += 1
    })

    try {
      await setup.flush()
      setup.mockInput.pressKey('c', { ctrl: true })
      await setup.flush()

      expect(abandoned).toBe(1)
    } finally {
      await teardown(setup)
    }
  }, 60_000)

  it('leaves ctrl+c to the workspace once the harness is up', async () => {
    let abandoned = 0
    const setup = await mount(Promise.resolve(ready(appWith())), () => {
      abandoned += 1
    })

    try {
      await framesUntilLifted(setup)
      setup.mockInput.pressKey('c', { ctrl: true })
      await setup.flush()

      expect(abandoned).toBe(0)
    } finally {
      await teardown(setup)
    }
  }, 60_000)

  it('never lets the workspace paint before it is settled', async () => {
    const setup = await mount(Promise.resolve(ready(appWith())))

    try {
      const frames = await framesUntilLifted(setup)
      const lifted = frames.findIndex((frame) => frame.includes(WORKSPACE))

      expect(lifted).toBeGreaterThan(0)
      for (const frame of frames.slice(0, lifted)) {
        expect(frame).not.toContain(WORKSPACE)
      }
    } finally {
      await teardown(setup)
    }
  }, 60_000)

  it('leaves the workspace behind when it lifts', async () => {
    const setup = await mount(Promise.resolve(ready(appWith())))

    try {
      await framesUntilLifted(setup)
      await settle(LIFT_MS)
      await setup.flush()

      const frame = setup.captureCharFrame()
      expect(frame).toContain(WORKSPACE)
      expect(frame).not.toContain('opening the conversation')
    } finally {
      await teardown(setup)
    }
  }, 60_000)

  it('opens on the palette the operator chose, not the one Atlas ships', async () => {
    const app = appWith('moss')
    applyAppearance(appearanceOf({ resolution: app.settings.snapshot().resolution }))

    const setup = await mount(Promise.resolve(ready(app)))

    try {
      expect(theme.accent).toBe(accentHex('moss'))
      await framesUntilLifted(setup)
      expect(theme.accent).toBe(accentHex('moss'))
    } finally {
      await teardown(setup)
      resetPalette()
    }
  }, 60_000)

  it('gets out of the way for an operator who pressed a key', async () => {
    const setup = await mount(Promise.resolve(ready(appWith())))

    try {
      await setup.flush()
      setup.mockInput.pressKey('j')

      const started = Date.now()
      await framesUntilLifted(setup)

      expect(Date.now() - started).toBeLessThan(INK_MS)
    } finally {
      await teardown(setup)
    }
  }, 60_000)

  it('keeps the keys that lifted it out of the draft', async () => {
    const setup = await mount(Promise.resolve(ready(appWith())))

    try {
      await setup.flush()
      await setup.mockInput.typeText('zzz')
      await framesUntilLifted(setup)
      await settle(LIFT_MS)
      await setup.flush()

      expect(setup.captureCharFrame()).not.toContain('zzz')
    } finally {
      await teardown(setup)
    }
  }, 60_000)
})
