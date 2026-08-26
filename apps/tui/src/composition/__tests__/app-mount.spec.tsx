import { toBranchId } from '@dltech/atlas-core'
import { testRender } from '@opentui/react/test-utils'
import { describe, expect, it } from 'bun:test'
import React from 'react'

import { grammarsReady, settle, teardown } from '../../ui/markdown/__tests__/harness'
import { App } from '../app'
import { FAKE_CONFIG, fakeApp, failingModelPort, scriptedModelPort, type FakeApp } from './fake-app'

await grammarsReady()

const WIDTH = 90

const HEIGHT = 30

const BRANCH = toBranchId('opened-branch')

const THINKING = 'The loop reads the log, so position is derived rather than remembered.'

const REPLY = 'Atlas derives every prompt from the event log.'

const PROVIDER_ERROR = 'overloaded_error'

type Mounted = {
  app: FakeApp
  frame: () => Promise<string>
  nextFrame: () => Promise<string>
  typeText: (text: string) => Promise<void>
  pressEnter: () => void
  pressEscape: () => void
  done: () => Promise<void>
}

async function open(args: { app: FakeApp }): Promise<Mounted> {
  const setup = await testRender(<App app={args.app} opened={{ branchId: BRANCH, events: [] }} />, {
    width: WIDTH,
    height: HEIGHT,
  })

  return {
    app: args.app,
    frame: async () => {
      await setup.flush()
      await settle(250)
      await setup.flush()
      return setup.captureCharFrame()
    },
    nextFrame: async () => {
      await setup.flush()
      return setup.captureCharFrame()
    },
    typeText: (text) => setup.mockInput.typeText(text),
    pressEnter: () => setup.mockInput.pressEnter(),
    pressEscape: () => setup.mockInput.pressEscape(),
    done: () => teardown(setup),
  }
}

async function until(args: { holds: () => Promise<boolean>; within: number }): Promise<boolean> {
  const deadline = Date.now() + args.within
  while (Date.now() < deadline) {
    if (await args.holds()) return true
  }
  return false
}

describe('the app you can actually open', () => {
  it('opens straight into a transcript, with no menu and no error on an empty branch', async () => {
    const mounted = await open({ app: fakeApp({ model: scriptedModelPort({ script: { thinking: THINKING, reply: REPLY } }) }) })

    try {
      const frame = await mounted.frame()
      expect(frame).toContain(FAKE_CONFIG.cwd)
      expect(frame).toContain('Describe the work')
      expect(frame).toContain('Ask anything')
    } finally {
      await mounted.done()
    }
  }, 60_000)

  it('shows what was typed, then streams the thinking and the reply back', async () => {
    const mounted = await open({
      app: fakeApp({ model: scriptedModelPort({ script: { thinking: THINKING, reply: REPLY } }) }),
    })

    try {
      await mounted.typeText('what derives the prompt')
      expect(await mounted.frame()).toContain('what derives the prompt')

      mounted.pressEnter()

      const answered = await until({
        holds: async () => {
          const frame = await mounted.frame()
          return frame.includes('derives every prompt') && frame.includes('what derives the prompt')
        },
        within: 20_000,
      })

      expect(answered).toBe(true)

      const events = await mounted.app.log.read({ branchId: BRANCH })
      expect(events.map((event) => event.type)).toEqual(['user-said', 'assistant-said'])
    } finally {
      await mounted.done()
    }
  }, 60_000)

  it('sends what the buffer holds when the text and ⏎ arrive in one burst', async () => {
    const mounted = await open({
      app: fakeApp({ model: scriptedModelPort({ script: { thinking: THINKING, reply: REPLY } }) }),
    })

    try {
      await mounted.typeText('pasted without a render in between')
      mounted.pressEnter()

      const said = await until({
        holds: async () => {
          await mounted.frame()
          const events = await mounted.app.log.read({ branchId: BRANCH })
          return events.some(
            (event) => event.type === 'user-said' && event.text.includes('without a render'),
          )
        },
        within: 20_000,
      })

      expect(said).toBe(true)
    } finally {
      await mounted.done()
    }
  }, 60_000)

  it('shows a working line on the first frame after sending, so a slow turn is not a hung one', async () => {
    const mounted = await open({
      app: fakeApp({
        model: scriptedModelPort({ script: { thinking: THINKING, reply: REPLY }, perChunkMs: 400 }),
      }),
    })

    try {
      await mounted.frame()

      await mounted.typeText('go')
      mounted.pressEnter()

      const first = await mounted.nextFrame()
      expect(first).toContain('Working for')
      expect(first).toContain('esc to interrupt')
    } finally {
      await mounted.done()
    }
  }, 60_000)

  it('leaves an interrupted reply in the transcript, marked', async () => {
    const mounted = await open({
      app: fakeApp({
        model: scriptedModelPort({
          script: { thinking: THINKING, reply: REPLY },
          perChunkMs: 120,
        }),
      }),
    })

    try {
      await mounted.typeText('go')
      mounted.pressEnter()

      const streaming = await until({
        holds: async () => (await mounted.frame()).includes('Thinking'),
        within: 20_000,
      })
      expect(streaming).toBe(true)

      mounted.pressEscape()

      const kept = await until({
        holds: async () => (await mounted.frame()).includes('Interrupted by you'),
        within: 20_000,
      })
      expect(kept).toBe(true)

      const events = await mounted.app.log.read({ branchId: BRANCH })
      const last = events.at(-1)
      expect(last?.type).toBe('assistant-said')
      expect(last?.type === 'assistant-said' ? last.interrupted : false).toBe(true)
    } finally {
      await mounted.done()
    }
  }, 60_000)

  it('names the model error rather than falling silent when the turn failed before any reply', async () => {
    const mounted = await open({
      app: fakeApp({ model: failingModelPort({ message: PROVIDER_ERROR }) }),
    })

    try {
      await mounted.typeText('what changed?')
      mounted.pressEnter()

      const blamed = await until({
        holds: async () => (await mounted.frame()).includes(PROVIDER_ERROR),
        within: 20_000,
      })

      expect(blamed).toBe(true)
      const frame = await mounted.frame()
      expect(frame).toContain('failed')
      expect(frame).not.toContain('The model reported no reason.')
    } finally {
      await mounted.done()
    }
  }, 60_000)
})
