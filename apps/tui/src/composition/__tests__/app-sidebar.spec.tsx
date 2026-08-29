import { parseColor, type CapturedFrame, type Renderable } from '@opentui/core'
import { toThreadId } from '@dltech/atlas-core'
import { testRender } from '@opentui/react/test-utils'
import { describe, expect, it } from 'bun:test'
import React from 'react'

import { grammarsReady, settle, teardown } from '../../ui/markdown/__tests__/harness'
import { theme, SIDEBAR_GUTTER, SIDEBAR_WIDTH } from '../../ui/theme'
import { App } from '../app'
import { FAKE_CONFIG, fakeApp, scriptedModelPort, type FakeApp } from './fake-app'

await grammarsReady()

const THREAD = toThreadId('opened-thread')

const THINKING = 'The loop reads the log, so position is derived rather than remembered.'

const REPLY = 'Atlas derives every prompt from the event log.'

/** The wordmark is the sidebar's alone — the footer carries where you are and what answers. */
const SIDEBAR_MARK = '● atlas'

const PLACEHOLDER = 'Ask anything'

const WIDE = 140

const hexOf = (colour: { r: number; g: number; b: number }): string =>
  [colour.r, colour.g, colour.b]
    .map((channel) => Math.round(channel * 255).toString(16).padStart(2, '0'))
    .join('')

function groundsAcross(args: { frame: CapturedFrame; needle: string }): string[] {
  const line = args.frame.lines.find((candidate) =>
    candidate.spans.some((span) => span.text.includes(args.needle)),
  )
  if (line === undefined) throw new Error(`no row carried ${args.needle}`)

  return line.spans.flatMap((span) =>
    Array.from({ length: span.text.length }, () => hexOf(span.bg)),
  )
}

const NARROW = 90

async function pressCtrlB(setup: Awaited<ReturnType<typeof testRender>>): Promise<void> {
  setup.mockInput.pressKey('b', { ctrl: true })
  await setup.flush()
}

function contentColumnWidth(setup: Awaited<ReturnType<typeof testRender>>): number {
  const beside = (node: Renderable): Renderable | null => {
    const children = node.getChildren()
    const column = children[0]
    if (column !== undefined && children.length > 1 && children[1]?.width === SIDEBAR_WIDTH) {
      return column
    }

    for (const child of children) {
      const found = beside(child)
      if (found !== null) return found
    }

    return null
  }

  const column = beside(setup.renderer.root)
  if (column === null) throw new Error('no column was laid out beside the sidebar')

  return column.width
}

async function resizeTo(args: {
  setup: Awaited<ReturnType<typeof testRender>>
  width: number
}): Promise<void> {
  args.setup.resize(args.width, 40)
  await args.setup.flush()
  await settle(250)
  await args.setup.flush()
}

describe('the sidebar', () => {
  it('docks beside the transcript on a wide terminal', async () => {
    const app: FakeApp = fakeApp({ model: scriptedModelPort({ script: { thinking: THINKING, reply: REPLY } }) })
    const setup = await testRender(<App app={app} opened={{ threadId: THREAD, events: [], name: null }} />, {
      width: 140,
      height: 40,
    })

    try {
      await setup.flush()
      await settle(250)
      await setup.flush()

      const frame = setup.captureCharFrame()
      expect(frame).toContain(SIDEBAR_MARK)
    } finally {
      await teardown(setup)
    }
  }, 60_000)

  it('stays hidden on a narrow terminal until ctrl+b opens it as an overlay', async () => {
    const app: FakeApp = fakeApp({ model: scriptedModelPort({ script: { thinking: THINKING, reply: REPLY } }) })
    const setup = await testRender(<App app={app} opened={{ threadId: THREAD, events: [], name: null }} />, {
      width: 90,
      height: 30,
    })

    try {
      await setup.flush()
      await settle(250)
      await setup.flush()

      expect(setup.captureCharFrame()).not.toContain(SIDEBAR_MARK)

      await pressCtrlB(setup)
      await settle(250)

      expect(setup.captureCharFrame()).toContain(SIDEBAR_MARK)

      await pressCtrlB(setup)
      await settle(250)

      expect(setup.captureCharFrame()).not.toContain(SIDEBAR_MARK)
    } finally {
      await teardown(setup)
    }
  }, 60_000)

  it('is reached across a gutter the composer alone gives up', async () => {
    const app: FakeApp = fakeApp({ model: scriptedModelPort({ script: { thinking: THINKING, reply: REPLY } }) })
    const setup = await testRender(<App app={app} opened={{ threadId: THREAD, events: [], name: null }} />, {
      width: WIDE,
      height: 40,
    })

    try {
      await setup.flush()
      await settle(250)
      await setup.flush()

      const grounds = groundsAcross({ frame: setup.captureSpans(), needle: PLACEHOLDER })
      const edge = WIDE - SIDEBAR_WIDTH
      const ground = hexOf(parseColor(theme.appBg))
      const panel = hexOf(parseColor(theme.panelBg))

      expect(grounds[edge - SIDEBAR_GUTTER - 1]).toBe(panel)
      for (let column = edge - SIDEBAR_GUTTER; column < edge; column += 1) {
        expect(grounds[column]).toBe(ground)
      }
      expect(grounds[edge]).toBe(panel)
    } finally {
      await teardown(setup)
    }
  }, 60_000)

  it('folds away on a wide terminal when ctrl+b hides it', async () => {
    const app: FakeApp = fakeApp({ model: scriptedModelPort({ script: { thinking: THINKING, reply: REPLY } }) })
    const setup = await testRender(<App app={app} opened={{ threadId: THREAD, events: [], name: null }} />, {
      width: 140,
      height: 40,
    })

    try {
      await setup.flush()
      await settle(250)

      await pressCtrlB(setup)
      await settle(250)

      expect(setup.captureCharFrame()).not.toContain(SIDEBAR_MARK)
    } finally {
      await teardown(setup)
    }
  }, 60_000)

  it('comes back on widening after a narrow peek was opened and closed', async () => {
    const app: FakeApp = fakeApp({ model: scriptedModelPort({ script: { thinking: THINKING, reply: REPLY } }) })
    const setup = await testRender(<App app={app} opened={{ threadId: THREAD, events: [], name: null }} />, {
      width: NARROW,
      height: 40,
    })

    try {
      await setup.flush()
      await settle(250)
      await setup.flush()

      await pressCtrlB(setup)
      await settle(250)
      await pressCtrlB(setup)
      await settle(250)

      expect(setup.captureCharFrame()).not.toContain(SIDEBAR_MARK)

      await resizeTo({ setup, width: WIDE })

      expect(setup.captureCharFrame()).toContain(SIDEBAR_MARK)
    } finally {
      await teardown(setup)
    }
  }, 60_000)

  it('auto-collapses on narrowing after it was opened again on a wide terminal', async () => {
    const app: FakeApp = fakeApp({ model: scriptedModelPort({ script: { thinking: THINKING, reply: REPLY } }) })
    const setup = await testRender(<App app={app} opened={{ threadId: THREAD, events: [], name: null }} />, {
      width: WIDE,
      height: 40,
    })

    try {
      await setup.flush()
      await settle(250)
      await setup.flush()

      await pressCtrlB(setup)
      await settle(250)
      await pressCtrlB(setup)
      await settle(250)

      expect(setup.captureCharFrame()).toContain(SIDEBAR_MARK)

      await resizeTo({ setup, width: NARROW })

      expect(setup.captureCharFrame()).not.toContain(SIDEBAR_MARK)
    } finally {
      await teardown(setup)
    }
  }, 60_000)

  it('lays the transcript out beside the sidebar once a narrow peek is widened', async () => {
    const app: FakeApp = fakeApp({ model: scriptedModelPort({ script: { thinking: THINKING, reply: REPLY } }) })
    const setup = await testRender(<App app={app} opened={{ threadId: THREAD, events: [], name: null }} />, {
      width: NARROW,
      height: 40,
    })

    try {
      await setup.flush()
      await settle(250)
      await setup.flush()

      await pressCtrlB(setup)
      await settle(250)

      expect(contentColumnWidth(setup)).toBe(NARROW)

      await resizeTo({ setup, width: WIDE })

      expect(contentColumnWidth(setup)).toBe(WIDE - SIDEBAR_WIDTH)
    } finally {
      await teardown(setup)
    }
  }, 60_000)
})
