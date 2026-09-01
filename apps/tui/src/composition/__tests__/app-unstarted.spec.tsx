import { testRender } from '@opentui/react/test-utils'
import { describe, expect, it } from 'bun:test'
import React from 'react'

import { grammarsReady, settle, teardown } from '../../ui/markdown/__tests__/harness'
import { App } from '../app'
import type { OpenedConversation } from '../open-conversation'
import { open, until, THREAD, REPLY, THINKING } from './app-fixture'
import { FAKE_WORKSPACE } from './fake-backend'
import { fakeApp, scriptedModelPort, type FakeApp } from './fake-app'

await grammarsReady()

const OPENING = 'take the linter to zero'

const WITHIN_MS = 20_000

const UNSTARTED: OpenedConversation = {
  threadId: THREAD,
  events: [],
  turns: [],
  name: null,
  started: false,
}

const WIDE = { width: 140, height: 40 }

/** The wordmark is the sidebar's alone — the footer carries where you are and what answers. */
const SIDEBAR_MARK = '● atlas'

const speaking = (): FakeApp =>
  fakeApp({ model: scriptedModelPort({ script: { thinking: THINKING, reply: REPLY } }) })

describe('the welcome screen a conversation opens on', () => {
  it('keeps the sidebar away, since there is no conversation for it to read', async () => {
    const setup = await testRender(<App app={speaking()} opened={UNSTARTED} />, WIDE)

    try {
      await setup.flush()
      await settle(250)
      await setup.flush()

      expect(setup.captureCharFrame()).not.toContain(SIDEBAR_MARK)
    } finally {
      await teardown(setup)
    }
  }, 60_000)

  it('hands the sidebar back the moment something is said', async () => {
    const setup = await testRender(<App app={speaking()} opened={UNSTARTED} />, WIDE)

    try {
      await setup.flush()
      await settle(250)
      await setup.flush()

      await setup.mockInput.typeText(OPENING)
      setup.mockInput.pressEnter()
      await settle(2_000)
      await setup.flush()

      expect(setup.captureCharFrame()).toContain(SIDEBAR_MARK)
    } finally {
      await teardown(setup)
    }
  }, 60_000)
})

describe('a conversation nobody has spoken in', () => {
  it('writes nothing to the store while it sits on the welcome screen', async () => {
    const mounted = await open({ app: speaking(), opened: UNSTARTED })

    try {
      await mounted.frame()

      expect(mounted.app.threads.created).toBe(0)
      expect(await mounted.app.threads.list({ workspace: FAKE_WORKSPACE })).toEqual([])
    } finally {
      await mounted.done()
    }
  })

  it('opens the thread with the first message, under the id it was already handed', async () => {
    const mounted = await open({ app: speaking(), opened: UNSTARTED })

    try {
      await mounted.typeText(OPENING)
      mounted.pressEnter()

      const spoke = await until({
        holds: async () => (await mounted.frame()).includes(REPLY),
        within: WITHIN_MS,
      })

      expect(spoke).toBe(true)
      expect(mounted.app.threads.created).toBe(1)
      expect((await mounted.app.log.read({ threadId: THREAD })).length).toBeGreaterThan(0)
    } finally {
      await mounted.done()
    }
  })

  it('opens the thread once, so the second message appends to the first', async () => {
    const mounted = await open({ app: speaking(), opened: UNSTARTED })

    try {
      await mounted.typeText(OPENING)
      mounted.pressEnter()
      await until({
        holds: async () => (await mounted.frame()).includes(REPLY),
        within: WITHIN_MS,
      })

      await mounted.typeText('and again')
      mounted.pressEnter()
      await until({
        holds: async () => {
          await mounted.frame()
          return (await mounted.app.log.read({ threadId: THREAD })).length > 3
        },
        within: WITHIN_MS,
      })

      expect(mounted.app.threads.created).toBe(1)
    } finally {
      await mounted.done()
    }
  })
})
