import { toThreadId } from '@dltech/atlas-core'
import { testRender } from '@opentui/react/test-utils'
import { describe, expect, it } from 'bun:test'
import React from 'react'

import { grammarsReady, settle, teardown } from '../../ui/markdown/__tests__/harness'
import { EKeyGroup } from '../../ui/keys'
import { App } from '../app'
import { FAKE_CONFIG, fakeApp, fakeSkill, scriptedModelPort, type FakeApp } from './fake-app'

const PIRATE = fakeSkill({
  name: 'pirate',
  summary: 'answer entirely in pirate dialect',
  body: 'Answer entirely in pirate dialect.',
})

await grammarsReady()

const THREAD = toThreadId('opened-thread')

const WIDE = { width: 150, height: 40 }

const READ_MS = 60

type Mounted = Awaited<ReturnType<typeof testRender>>

const appWith = (): FakeApp =>
  fakeApp({ model: scriptedModelPort({ script: { thinking: 'weighing it', reply: 'done' } }) })

async function landed(setup: Mounted): Promise<void> {
  await settle(READ_MS)
  await setup.flush()
}

async function opened(app: FakeApp): Promise<Mounted> {
  const setup = await testRender(
    <App
      app={app}
      opened={{ threadId: THREAD, events: [], turns: [], name: null, started: true }}
    />,
    WIDE,
  )
  await setup.flush()
  await settle(250)
  await setup.flush()
  return setup
}

describe('a message that loaded a skill', () => {
  it('says which skill it pulled in, beneath what was typed', async () => {
    const app = fakeApp({
      model: scriptedModelPort({ script: { thinking: 'weighing it', reply: 'arr' } }),
      skills: [PIRATE],
    })
    const setup = await opened(app)

    try {
      await setup.mockInput.typeText('/pirate how about now?')
      await landed(setup)

      setup.mockInput.pressEnter()
      await settle(2_000)
      await setup.flush()

      const frame = setup.captureCharFrame()
      expect(frame).toContain('/pirate how about now?')
      expect(frame).toContain('⎿ skill pirate')
    } finally {
      await teardown(setup)
    }
  }, 60_000)

  it('says nothing beneath a message that loaded none', async () => {
    const setup = await opened(appWith())

    try {
      await setup.mockInput.typeText('plain question')
      await landed(setup)
      setup.mockInput.pressEnter()
      await settle(2_000)
      await setup.flush()

      expect(setup.captureCharFrame()).not.toContain('⎿ skill')
    } finally {
      await teardown(setup)
    }
  }, 60_000)
})

describe('the command menu', () => {
  it('stays closed while the draft holds ordinary prose', async () => {
    const setup = await opened(appWith())

    try {
      await setup.mockInput.typeText('fix the build')
      await landed(setup)

      expect(setup.captureCharFrame()).not.toContain('replace the history so far')
    } finally {
      await teardown(setup)
    }
  }, 60_000)

  it('opens on a bare slash and lists what can be run', async () => {
    const setup = await opened(appWith())

    try {
      await setup.mockInput.typeText('/')
      await landed(setup)

      const frame = setup.captureCharFrame()
      expect(frame).toContain('compact')
      expect(frame).toContain('replace the history so far')
    } finally {
      await teardown(setup)
    }
  }, 60_000)

  it('narrows to what is still reachable as the name is typed', async () => {
    const setup = await opened(appWith())

    try {
      await setup.mockInput.typeText('/comp')
      await landed(setup)

      const frame = setup.captureCharFrame()
      expect(frame).toContain('compact')
      expect(frame).not.toContain('background shells')
    } finally {
      await teardown(setup)
    }
  }, 60_000)

  it('sits flush against the composer, spending no row on the notice gutter', async () => {
    const setup = await opened(appWith())

    try {
      await setup.mockInput.typeText('/comp')
      await landed(setup)

      const rows = setup.captureCharFrame().split('\n')
      const listed = rows.findIndex((row) => row.includes('replace the history so far'))
      const drafted = rows.findIndex((row, index) => index > listed && row.includes('/comp'))
      const between = rows.slice(listed + 1, drafted)

      expect(listed).toBeGreaterThan(-1)
      expect(between.every((row) => row.trim() !== '')).toBe(true)
    } finally {
      await teardown(setup)
    }
  }, 60_000)

  it('closes on escape and leaves the draft alone', async () => {
    const setup = await opened(appWith())

    try {
      await setup.mockInput.typeText('/comp')
      await landed(setup)
      expect(setup.captureCharFrame()).toContain('replace the history so far')

      setup.mockInput.pressEscape()
      await landed(setup)

      const frame = setup.captureCharFrame()
      expect(frame).not.toContain('replace the history so far')
      expect(frame).toContain('/comp')
    } finally {
      await teardown(setup)
    }
  }, 60_000)

  it('completes a half-typed name on tab rather than running it', async () => {
    const app = appWith()
    const setup = await opened(app)

    try {
      await setup.mockInput.typeText('/hel')
      await landed(setup)

      setup.mockInput.pressTab()
      await landed(setup)

      const frame = setup.captureCharFrame()
      expect(frame).toContain('/help')
      expect(frame).not.toContain(EKeyGroup.Composer.toUpperCase())
      expect(app.turnsDriven).toBe(0)
    } finally {
      await teardown(setup)
    }
  }, 60_000)

  it('leaves no stray newline in the draft when a key completes a name', async () => {
    const setup = await opened(appWith())

    try {
      await setup.mockInput.typeText('/hel')
      await landed(setup)

      setup.mockInput.pressEnter()
      await landed(setup)
      await setup.mockInput.typeText('now')
      await landed(setup)

      expect(setup.captureCharFrame()).toContain('/help now')
    } finally {
      await teardown(setup)
    }
  }, 60_000)

  it('leaves no stray tab in the draft when tab completes a name', async () => {
    const setup = await opened(appWith())

    try {
      await setup.mockInput.typeText('/hel')
      await landed(setup)

      setup.mockInput.pressTab()
      await landed(setup)
      await setup.mockInput.typeText('now')
      await landed(setup)

      expect(setup.captureCharFrame()).toContain('/help now')
    } finally {
      await teardown(setup)
    }
  }, 60_000)

  it('runs a local command rather than sending it to the model', async () => {
    const app = appWith()
    const setup = await opened(app)

    try {
      await setup.mockInput.typeText('/help')
      await landed(setup)

      setup.mockInput.pressEnter()
      await landed(setup)

      expect(setup.captureCharFrame()).toContain(EKeyGroup.Composer.toUpperCase())
      expect(app.turnsDriven).toBe(0)
    } finally {
      await teardown(setup)
    }
  }, 60_000)
})

describe('a fresh conversation started from inside the app', () => {
  it('writes nothing until it is spoken in, so it never shows up as a blank to resume', async () => {
    const app = appWith()
    const setup = await opened(app)

    try {
      await setup.mockInput.typeText('/new')
      setup.mockInput.pressEnter()
      await landed(setup)

      expect(app.threads.createdWith).toEqual([])
    } finally {
      await teardown(setup)
    }
  }, 60_000)

  it('is filed under the workspace by its first message, so tomorrow can resume it', async () => {
    const app = appWith()
    const setup = await opened(app)

    try {
      await setup.mockInput.typeText('/new')
      setup.mockInput.pressEnter()
      await landed(setup)

      await setup.mockInput.typeText('the first thing said in it')
      setup.mockInput.pressEnter()
      await settle(2_000)
      await setup.flush()

      expect(app.threads.createdWith).toEqual([{ workspace: FAKE_CONFIG.cwd, repo: null }])
    } finally {
      await teardown(setup)
    }
  }, 60_000)

  it('also starts on ctrl+n, without typing /new', async () => {
    const app = appWith()
    const setup = await opened(app)

    try {
      await setup.mockInput.typeText('something said before')
      setup.mockInput.pressEnter()
      await settle(2_000)
      await setup.flush()

      expect(setup.captureCharFrame()).toContain('something said before')

      setup.mockInput.pressKey('n', { ctrl: true })
      await landed(setup)

      expect(setup.captureCharFrame()).not.toContain('something said before')
    } finally {
      await teardown(setup)
    }
  }, 60_000)
})
