import { describe, expect, it } from 'bun:test'

import React from 'react'
import { testRender } from '@opentui/react/test-utils'

import { EExecutionLocation, ESettingId, type SettingsDocument } from '@dltech/atlas-core'
import { ESandboxState } from '@dltech/atlas-harness'

import { grammarsReady, settle, teardown } from '../../ui/markdown/__tests__/harness'
import { App } from '../app'
import type { OpenedConversation } from '../open-conversation'
import { open, spokenIn, until, REPLY, THREAD, THINKING } from './app-fixture'
import { fakeApp, scriptedModelPort, type FakeApp } from './fake-app'

await grammarsReady()

const WITHIN_MS = 20_000

const UNSTARTED: OpenedConversation = {
  threadId: THREAD,
  events: [],
  turns: [],
  name: null,
  started: false,
}

const speaking = (settings?: SettingsDocument): FakeApp =>
  fakeApp({
    model: scriptedModelPort({ script: { thinking: THINKING, reply: REPLY } }),
    ...(settings === undefined ? {} : { settings }),
  })

const switchTo = async (mounted: Awaited<ReturnType<typeof open>>, argument: string) => {
  await mounted.typeText(`/container ${argument}`)
  mounted.pressEnter()
  await mounted.frame()
}

describe('the container command', () => {
  it('writes the column the moment the operator switches, mid-session', async () => {
    const app = speaking()
    const mounted = await open({ app, opened: await spokenIn(app) })

    try {
      await switchTo(mounted, 'docker')

      expect(app.threads.chosenLocations).toEqual([
        { threadId: THREAD, location: EExecutionLocation.Docker },
      ])
      expect(app.executionLocation.current()).toBe(EExecutionLocation.Docker)
    } finally {
      await mounted.done()
    }
  })

  it('answers where the conversation runs without moving it', async () => {
    const app = speaking()
    const mounted = await open({ app, opened: await spokenIn(app) })

    try {
      await switchTo(mounted, '')

      expect(app.threads.chosenLocations).toEqual([])
      expect(app.executionLocation.current()).toBe(EExecutionLocation.Host)
    } finally {
      await mounted.done()
    }
  })

  it('starts a conversation where the settings file puts it', async () => {
    const app = speaking({ values: { [ESettingId.ExecutionLocation]: 'docker' } })
    const mounted = await open({ app, opened: await spokenIn(app) })

    try {
      await mounted.frame()

      expect(app.executionLocation.current()).toBe(EExecutionLocation.Docker)
      expect(app.threads.chosenLocations).toEqual([])
    } finally {
      await mounted.done()
    }
  })

  it('starts a fresh conversation from the default, not from the thread it just left', async () => {
    const app = speaking()
    const mounted = await open({ app, opened: await spokenIn(app) })

    try {
      await switchTo(mounted, 'docker')
      expect(app.executionLocation.current()).toBe(EExecutionLocation.Docker)

      await mounted.typeText('/new')
      mounted.pressEnter()
      await mounted.frame()

      expect(app.executionLocation.current()).toBe(EExecutionLocation.Host)
    } finally {
      await mounted.done()
    }
  })

  it('holds a switch made before the thread exists until the first message opens it', async () => {
    const app = speaking()
    const mounted = await open({ app, opened: UNSTARTED })

    try {
      await switchTo(mounted, 'docker')

      expect(app.threads.chosenLocations).toEqual([])
      expect(app.executionLocation.current()).toBe(EExecutionLocation.Docker)

      await mounted.typeText('take the linter to zero')
      mounted.pressEnter()

      const landed = await until({
        holds: async () => app.threads.chosenLocations.length > 0,
        within: WITHIN_MS,
      })

      expect(landed).toBe(true)
      expect(app.threads.chosenLocations).toEqual([
        { threadId: THREAD, location: EExecutionLocation.Docker },
      ])
    } finally {
      await mounted.done()
    }
  }, 60_000)

  it('never reaches for the sandbox on a fresh conversation or a location switch', async () => {
    const app = speaking({ values: { [ESettingId.ExecutionLocation]: 'docker' } })
    const mounted = await open({ app, opened: await spokenIn(app) })

    try {
      await switchTo(mounted, 'docker')
      await mounted.typeText('/new')
      mounted.pressEnter()
      await mounted.frame()

      expect(app.sandboxStops).toBe(0)
    } finally {
      await mounted.done()
    }
  }, 60_000)
})

describe('the container pill in the sidebar', () => {
  it('is absent on the host and answers with the sandbox state in docker', async () => {
    const app = speaking()
    const setup = await testRender(<App app={app} opened={await spokenIn(app)} />, {
      width: 140,
      height: 40,
    })

    try {
      await setup.flush()
      await settle(250)
      await setup.flush()
      expect(setup.captureCharFrame()).not.toContain('CONTAINER')

      await setup.mockInput.typeText('/container docker')
      setup.mockInput.pressEnter()
      await setup.flush()
      await settle(250)
      await setup.flush()

      const hosting = setup.captureCharFrame()
      expect(hosting).toContain('CONTAINER')
      expect(hosting).toContain('stopped')
      expect(hosting).toContain('node:22-slim')

      app.containerStatus.mark({
        state: ESandboxState.Running,
        ports: [{ containerPort: 3000, hostPort: 20_123 }],
      })
      await setup.flush()
      await settle(250)
      await setup.flush()

      const running = setup.captureCharFrame()
      expect(running).toContain('running')
      expect(running).toContain('3000→20123')
    } finally {
      await teardown(setup)
    }
  }, 60_000)
})
