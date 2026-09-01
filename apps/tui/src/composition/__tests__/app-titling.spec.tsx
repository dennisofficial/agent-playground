import { testRender } from '@opentui/react/test-utils'
import { describe, expect, it } from 'bun:test'
import React from 'react'

import { grammarsReady, settle, teardown } from '../../ui/markdown/__tests__/harness'
import { App } from '../app'
import { open, until, THREAD, REPLY, THINKING } from './app-fixture'
import { fakeApp, scriptedModelPort, type FakeApp } from './fake-app'

await grammarsReady()

const NAME = 'Refresh-token rotation'

const HANDLE = 'refresh-token-rotation'

const OPENING = 'the refresh token never rotates'

const FOLLOW_UP = 'and cover reuse detection'

const WITHIN_MS = 20_000

const script = { thinking: THINKING, reply: REPLY }

const naming = (names: string | null): FakeApp =>
  fakeApp({ model: scriptedModelPort({ script }), names })

describe('naming a session from its opening message', () => {
  it('asks for a name and writes it to the thread', async () => {
    const mounted = await open({ app: naming(NAME) })

    try {
      await mounted.typeText(OPENING)
      mounted.pressEnter()

      const named = await until({
        holds: async () => {
          await mounted.frame()
          return mounted.app.threads.renames.length > 0
        },
        within: WITHIN_MS,
      })

      expect(named).toBe(true)
      expect(mounted.app.titled).toEqual([OPENING])
      expect(mounted.app.threads.renames).toEqual([{ threadId: THREAD, title: NAME }])
    } finally {
      await mounted.done()
    }
  })

  it('asks once, however many turns the session runs', async () => {
    const mounted = await open({ app: naming(NAME) })

    try {
      await mounted.typeText(OPENING)
      mounted.pressEnter()

      const settled = await until({
        holds: async () => (await mounted.frame()).includes(REPLY),
        within: WITHIN_MS,
      })
      expect(settled).toBe(true)

      await mounted.typeText(FOLLOW_UP)
      mounted.pressEnter()

      const ran = await until({
        holds: async () => {
          await mounted.frame()
          return mounted.app.turnsDriven === 2
        },
        within: WITHIN_MS,
      })

      expect(ran).toBe(true)
      expect(mounted.app.titled).toEqual([OPENING])
      expect(mounted.app.threads.renames).toHaveLength(1)
    } finally {
      await mounted.done()
    }
  })

  it('leaves the thread unnamed when the titler declines, rather than failing the turn', async () => {
    const mounted = await open({ app: naming(null) })

    try {
      await mounted.typeText(OPENING)
      mounted.pressEnter()

      const settled = await until({
        holds: async () => (await mounted.frame()).includes(REPLY),
        within: WITHIN_MS,
      })

      expect(settled).toBe(true)
      expect(mounted.app.titled).toEqual([OPENING])
      expect(mounted.app.threads.renames).toEqual([])
    } finally {
      await mounted.done()
    }
  })

  it('drops the name when a new conversation starts, rather than carrying it over', async () => {
    const app = naming(NAME)
    const setup = await testRender(
      <App app={app} opened={{ threadId: THREAD, events: [], turns: [], name: null, started: true }} />,
      { width: 140, height: 40 },
    )

    const frame = async (): Promise<string> => {
      await setup.flush()
      await settle(250)
      await setup.flush()
      return setup.captureCharFrame()
    }

    try {
      await setup.mockInput.typeText(OPENING)
      setup.mockInput.pressEnter()

      expect(await until({ holds: async () => (await frame()).includes(NAME), within: WITHIN_MS })).toBe(true)

      await setup.mockInput.typeText('/new')
      setup.mockInput.pressEnter()

      const dropped = await until({
        holds: async () => !(await frame()).includes(NAME),
        within: WITHIN_MS,
      })

      expect(dropped).toBe(true)
    } finally {
      await teardown(setup)
    }
  })

  it('heads the sidebar with the name once it lands', async () => {
    const app = naming(NAME)
    const setup = await testRender(
      <App app={app} opened={{ threadId: THREAD, events: [], turns: [], name: null, started: true }} />,
      { width: 140, height: 40 },
    )

    try {
      await setup.flush()
      await setup.mockInput.typeText(OPENING)
      setup.mockInput.pressEnter()

      const headed = await until({
        holds: async () => {
          await setup.flush()
          await settle(250)
          await setup.flush()
          return setup.captureCharFrame().includes(NAME)
        },
        within: WITHIN_MS,
      })

      expect(headed).toBe(true)
    } finally {
      await teardown(setup)
    }
  })

  it('heads the composer with the handle the session resumes by, not the written name', async () => {
    const app = naming(NAME)
    const setup = await testRender(
      <App app={app} opened={{ threadId: THREAD, events: [], turns: [], name: null, started: true }} />,
      { width: 140, height: 40 },
    )

    try {
      await setup.flush()
      await setup.mockInput.typeText(OPENING)
      setup.mockInput.pressEnter()

      const headed = await until({
        holds: async () => {
          await setup.flush()
          await settle(250)
          await setup.flush()
          return setup.captureCharFrame().includes(HANDLE)
        },
        within: WITHIN_MS,
      })

      expect(headed).toBe(true)
    } finally {
      await teardown(setup)
    }
  })
})

const RENAMED = 'Doing something cool'

describe('renaming a session with /rename', () => {
  it('takes the name the operator wrote, without asking the titler', async () => {
    const mounted = await open({ app: naming(NAME) })

    try {
      await mounted.typeText(`/rename ${RENAMED}`)
      mounted.pressEnter()

      const named = await until({
        holds: async () => {
          await mounted.frame()
          return mounted.app.threads.renames.length > 0
        },
        within: WITHIN_MS,
      })

      expect(named).toBe(true)
      expect(mounted.app.threads.renames).toEqual([{ threadId: THREAD, title: RENAMED }])
      expect(mounted.app.titled).toEqual([])
    } finally {
      await mounted.done()
    }
  })

  it('names the session again from the transcript when no name is written', async () => {
    const mounted = await open({ app: naming(NAME) })

    try {
      await mounted.typeText(OPENING)
      mounted.pressEnter()

      expect(
        await until({ holds: async () => (await mounted.frame()).includes(REPLY), within: WITHIN_MS }),
      ).toBe(true)

      await mounted.typeText('/rename')
      mounted.pressEnter()

      const named = await until({
        holds: async () => {
          await mounted.frame()
          return mounted.app.titled.length > 1
        },
        within: WITHIN_MS,
      })

      expect(named).toBe(true)
      expect(mounted.app.titled.at(-1)).toContain(`Operator: ${OPENING}`)
      expect(mounted.app.titled.at(-1)).toContain(REPLY)
      expect(mounted.app.threads.renames.at(-1)).toEqual({ threadId: THREAD, title: NAME })
    } finally {
      await mounted.done()
    }
  })

  it('says what to do when there is nothing said yet to name the session from', async () => {
    const mounted = await open({ app: naming(NAME) })

    try {
      await mounted.typeText('/rename')
      mounted.pressEnter()

      const refused = await until({
        holds: async () => (await mounted.frame()).includes('nothing to read yet'),
        within: WITHIN_MS,
      })

      expect(refused).toBe(true)
      expect(mounted.app.threads.renames).toEqual([])
    } finally {
      await mounted.done()
    }
  })
})
