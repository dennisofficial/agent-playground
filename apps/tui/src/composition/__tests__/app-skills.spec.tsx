import { toThreadId } from '@dltech/atlas-core'
import { testRender } from '@opentui/react/test-utils'
import { describe, expect, it } from 'bun:test'
import React from 'react'

import { grammarsReady, settle, teardown } from '../../ui/markdown/__tests__/harness'
import { App } from '../app'
import { fakeApp, fakeSkill, scriptedModelPort, type FakeApp } from './fake-app'

await grammarsReady()

const THREAD = toThreadId('opened-thread')

const WIDE = { width: 150, height: 40 }

const READ_MS = 60

type Mounted = Awaited<ReturnType<typeof testRender>>

const appWith = (skills: readonly ReturnType<typeof fakeSkill>[] = []): FakeApp =>
  fakeApp({
    model: scriptedModelPort({ script: { thinking: 'weighing it', reply: 'arr' } }),
    skills,
  })

async function landed(setup: Mounted): Promise<void> {
  await settle(READ_MS)
  await setup.flush()
}

async function ran(setup: Mounted): Promise<void> {
  setup.mockInput.pressEnter()
  await settle(200)
  await setup.flush()
}

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

describe('the skills command', () => {
  it('reads the skill folders again rather than trusting what launch found', async () => {
    const app = appWith([fakeSkill({ name: 'pirate' })])
    const setup = await opened(app)

    try {
      expect(app.skillRegistry.reloads).toBe(0)

      await setup.mockInput.typeText('/skills')
      await landed(setup)
      await ran(setup)

      expect(app.skillRegistry.reloads).toBe(1)
      expect(app.turnsDriven).toBe(0)
    } finally {
      await teardown(setup)
    }
  }, 60_000)

  it('reloads the very registry the container holds, never a replacement for it', async () => {
    const app = appWith([fakeSkill({ name: 'pirate' })])
    const bound = app.skillRegistry
    const setup = await opened(app)

    try {
      app.skillRegistry.place(fakeSkill({ name: 'shanty' }))

      await setup.mockInput.typeText('/skills')
      await landed(setup)
      await ran(setup)

      expect(app.skillRegistry).toBe(bound)
      expect(bound.byName('shanty')).toBeDefined()
    } finally {
      await teardown(setup)
    }
  }, 60_000)

  it('says how many it holds and what the reload turned up', async () => {
    const app = appWith([fakeSkill({ name: 'pirate' })])
    const setup = await opened(app)

    try {
      app.skillRegistry.place(fakeSkill({ name: 'shanty' }))

      await setup.mockInput.typeText('/skills')
      await landed(setup)
      await ran(setup)

      const frame = setup.captureCharFrame()
      expect(frame).toContain('2 skills')
      expect(frame).toContain('added shanty')
    } finally {
      await teardown(setup)
    }
  }, 60_000)

  it('says so plainly when the reload turned nothing up', async () => {
    const app = appWith([fakeSkill({ name: 'pirate' })])
    const setup = await opened(app)

    try {
      await setup.mockInput.typeText('/skills')
      await landed(setup)
      await ran(setup)

      expect(setup.captureCharFrame()).toContain('1 skill, nothing new')
    } finally {
      await teardown(setup)
    }
  }, 60_000)

  it('names a skill it no longer finds rather than dropping it in silence', async () => {
    const app = appWith([fakeSkill({ name: 'pirate' })])
    const setup = await opened(app)

    try {
      app.skillRegistry.drop('pirate')

      await setup.mockInput.typeText('/skills')
      await landed(setup)
      await ran(setup)

      expect(setup.captureCharFrame()).toContain('dropped pirate')
    } finally {
      await teardown(setup)
    }
  }, 60_000)
})

describe('a skill dropped in mid-session', () => {
  it('stays out of the menu until something reloads', async () => {
    const app = appWith()
    const setup = await opened(app)

    try {
      app.skillRegistry.place(fakeSkill({ name: 'shanty', summary: 'sing it out' }))

      await setup.mockInput.typeText('/shan')
      await landed(setup)

      expect(setup.captureCharFrame()).not.toContain('sing it out')
    } finally {
      await teardown(setup)
    }
  }, 60_000)

  it('is offered in the menu once the reload has seen it, with no restart', async () => {
    const app = appWith()
    const setup = await opened(app)

    try {
      app.skillRegistry.place(fakeSkill({ name: 'shanty', summary: 'sing it out' }))

      await setup.mockInput.typeText('/skills')
      await landed(setup)
      await ran(setup)

      await setup.mockInput.typeText('/shan')
      await landed(setup)

      expect(setup.captureCharFrame()).toContain('sing it out')
    } finally {
      await teardown(setup)
    }
  }, 60_000)

  it('loads its body into the message that names it, with no restart', async () => {
    const app = appWith()
    const setup = await opened(app)

    try {
      app.skillRegistry.place(fakeSkill({ name: 'shanty', summary: 'sing it out' }))

      await setup.mockInput.typeText('/skills')
      await landed(setup)
      await ran(setup)

      await setup.mockInput.typeText('/shanty how about now?')
      await landed(setup)
      setup.mockInput.pressEnter()
      await settle(2_000)
      await setup.flush()

      expect(setup.captureCharFrame()).toContain('◆ shanty')
    } finally {
      await teardown(setup)
    }
  }, 60_000)
})

describe('a skill the author kept off the slash menu', () => {
  it('is left out of the menu while its neighbour is offered', async () => {
    const app = appWith([
      fakeSkill({ name: 'pirate', summary: 'answer in pirate dialect' }),
      fakeSkill({ name: 'ledger', summary: 'reconcile the ledger', userInvocable: false }),
    ])
    const setup = await opened(app)

    try {
      await setup.mockInput.typeText('/pir')
      await landed(setup)
      expect(setup.captureCharFrame()).toContain('answer in pirate dialect')

      await setup.mockInput.typeText('\u007f\u007f\u007fled')
      await landed(setup)
      expect(setup.captureCharFrame()).not.toContain('reconcile the ledger')
    } finally {
      await teardown(setup)
    }
  }, 60_000)

  it('stays out of the menu after a reload as well', async () => {
    const app = appWith()
    const setup = await opened(app)

    try {
      app.skillRegistry.place(
        fakeSkill({ name: 'ledger', summary: 'reconcile the ledger', userInvocable: false }),
      )

      await setup.mockInput.typeText('/skills')
      await landed(setup)
      await ran(setup)

      await setup.mockInput.typeText('/led')
      await landed(setup)

      expect(setup.captureCharFrame()).not.toContain('reconcile the ledger')
    } finally {
      await teardown(setup)
    }
  }, 60_000)
})
