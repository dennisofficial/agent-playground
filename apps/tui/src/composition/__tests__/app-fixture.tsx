import { toThreadId } from '@dltech/atlas-core'
import { testRender } from '@opentui/react/test-utils'
import React from 'react'

import { settle, teardown } from '../../ui/markdown/__tests__/harness'
import { App } from '../app'
import type { FakeApp } from './fake-app'

const WIDTH = 90

const HEIGHT = 30

export const THREAD = toThreadId('opened-thread')

export const THINKING = 'The loop reads the log, so position is derived rather than remembered.'

export const REPLY = 'Atlas derives every prompt from the event log.'

export type Mounted = {
  app: FakeApp
  frame: () => Promise<string>
  nextFrame: () => Promise<string>
  typeText: (text: string) => Promise<void>
  pressEnter: () => void
  pressEscape: () => void
  pressUp: () => void
  pressCtrl: (key: string) => void
  done: () => Promise<void>
}

export async function open(args: { app: FakeApp }): Promise<Mounted> {
  const setup = await testRender(<App app={args.app} opened={{ threadId: THREAD, events: [], name: null }} />, {
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
    pressUp: () => setup.mockInput.pressArrow('up'),
    pressCtrl: (key) => setup.mockInput.pressKey(key, { ctrl: true }),
    done: () => teardown(setup),
  }
}

export async function until(args: {
  holds: () => Promise<boolean>
  within: number
}): Promise<boolean> {
  const deadline = Date.now() + args.within
  while (Date.now() < deadline) {
    if (await args.holds()) return true
  }
  return false
}
