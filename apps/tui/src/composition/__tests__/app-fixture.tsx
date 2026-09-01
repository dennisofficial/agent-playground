import { toRunId, toThreadId } from '@dltech/atlas-core'
import type { MockMouse } from '@opentui/core/testing'
import { testRender } from '@opentui/react/test-utils'
import React from 'react'

import { settle, teardown } from '../../ui/markdown/__tests__/harness'
import type { ClipboardImageReader } from '../../ui/clipboard-image'
import { App } from '../app'
import type { OpenedConversation } from '../open-conversation'
import type { FakeApp } from './fake-app'

/**
 * A settled capture is not a safe stand-in here: several of these screens animate — the interrupt
 * spinner, the shimmer — so two captures taken microseconds apart match while the frame is still
 * moving, and the wait ends on a state the test was not waiting for.
 */
const SETTLE_MS = 250

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
  pressBackspace: () => void
  paste: (text: string) => Promise<void>
  pressUp: () => void
  pressLeft: () => void
  pressCtrl: (key: string) => void
  mouse: MockMouse
  done: () => Promise<void>
}

const EMPTY: OpenedConversation = {
  threadId: THREAD,
  events: [],
  turns: [],
  name: null,
  started: true,
}

/**
 * A conversation that has been spoken in, for the cases that need one — an empty transcript is the
 * welcome screen, which has no sidebar, no shells and nothing to scroll. The log is seeded rather
 * than the props alone: a refresh reads the store, so a conversation that exists only in
 * `opened.events` empties out mid-test and falls back to the welcome screen.
 */
export async function spokenIn(app: FakeApp): Promise<OpenedConversation> {
  const events = await app.log.append({
    threadId: THREAD,
    runId: toRunId('run-before'),
    drafts: [{ type: 'user-said', text: 'what is in here?' }],
  })

  return { threadId: THREAD, events, turns: [], name: null, started: true }
}

const NOTHING_ON_THE_CLIPBOARD: ClipboardImageReader = async () => null

export async function open(args: {
  app: FakeApp
  opened?: OpenedConversation
  clipboard?: ClipboardImageReader
}): Promise<Mounted> {
  const setup = await testRender(
    <App
      app={args.app}
      opened={args.opened ?? EMPTY}
      clipboard={args.clipboard ?? NOTHING_ON_THE_CLIPBOARD}
    />,
    { width: WIDTH, height: HEIGHT },
  )

  return {
    app: args.app,
    frame: async () => {
      await setup.flush()
      await settle(SETTLE_MS)
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
    pressBackspace: () => setup.mockInput.pressBackspace(),
    paste: (text) => setup.mockInput.pasteBracketedText(text),
    pressUp: () => setup.mockInput.pressArrow('up'),
    pressLeft: () => setup.mockInput.pressArrow('left'),
    pressCtrl: (key) => setup.mockInput.pressKey(key, { ctrl: true }),
    mouse: setup.mockMouse,
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
