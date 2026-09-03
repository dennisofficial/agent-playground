import { homedir } from 'node:os'

import { parseColor, type CapturedFrame, type Renderable } from '@opentui/core'
import { ESettingId, EWorktreeExit, toRunId, toThreadId } from '@dltech/atlas-core'
import { testRender } from '@opentui/react/test-utils'
import { describe, expect, it } from 'bun:test'
import React from 'react'

import { grammarsReady, settle, teardown } from '../../ui/markdown/__tests__/harness'
import { theme, SIDEBAR_GUTTER, SIDEBAR_WIDTH } from '../../ui/theme'
import { App } from '../app'
import { spokenIn } from './app-fixture'
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
    candidate.spans
      .map((span) => span.text)
      .join('')
      .includes(args.needle),
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
    const panelled = children.slice(1).some((child) => child.width === SIDEBAR_WIDTH)
    if (column !== undefined && panelled) return column

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
    const setup = await testRender(<App app={app} opened={await spokenIn(app)} />, {
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

  it('names the repository with the launch worktree beneath it when opened inside one', async () => {
    const repo = `${homedir()}/Developer/comp-v3`
    const worktree = `${repo}/.claude/worktrees/portal-auth-url`
    const app: FakeApp = fakeApp({
      model: scriptedModelPort({ script: { thinking: THINKING, reply: REPLY } }),
      cwd: worktree,
      workspace: { workspace: worktree, repo },
    })
    const setup = await testRender(<App app={app} opened={await spokenIn(app)} />, {
      width: 140,
      height: 40,
    })

    try {
      await setup.flush()
      await settle(250)
      await setup.flush()

      const rows = setup.captureCharFrame().split('\n')
      const mark = rows.findIndex((row) => row.includes(SIDEBAR_MARK))
      expect(rows[mark - 2]).toContain('~/Developer/comp-v3')
      expect(rows[mark - 1]).toContain('.claude/worktrees/portal-auth-url')
    } finally {
      await teardown(setup)
    }
  }, 60_000)

  it('names the main checkout alone once the session launched inside a worktree has left it', async () => {
    const repo = `${homedir()}/Developer/comp-v3`
    const worktree = `${repo}/.claude/worktrees/portal-auth-url`
    const app: FakeApp = fakeApp({
      model: scriptedModelPort({ script: { thinking: THINKING, reply: REPLY } }),
      cwd: worktree,
      workspace: { workspace: worktree, repo },
    })
    const events = await app.log.append({
      threadId: THREAD,
      runId: toRunId('run-before'),
      drafts: [
        { type: 'user-said', text: 'wrap it up' },
        { type: 'worktree-exited', path: worktree, action: EWorktreeExit.Keep, returnTo: repo },
      ],
    })
    const setup = await testRender(
      <App app={app} opened={{ threadId: THREAD, events, turns: [], name: null, started: true }} />,
      { width: 140, height: 40 },
    )

    try {
      await setup.flush()
      await settle(250)
      await setup.flush()

      const frame = setup.captureCharFrame()
      expect(frame).not.toContain('.claude/worktrees/portal-auth-url')

      const rows = frame.split('\n')
      const mark = rows.findIndex((row) => row.includes(SIDEBAR_MARK))
      expect(rows[mark - 1]).toContain('~/Developer/comp-v3')
    } finally {
      await teardown(setup)
    }
  }, 60_000)

  it('stays hidden on a narrow terminal until ctrl+b opens it as an overlay', async () => {
    const app: FakeApp = fakeApp({ model: scriptedModelPort({ script: { thinking: THINKING, reply: REPLY } }) })
    const setup = await testRender(<App app={app} opened={await spokenIn(app)} />, {
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
    const setup = await testRender(<App app={app} opened={await spokenIn(app)} />, {
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

  it('holds the sidebar docked on a wide terminal, where ctrl+b is not bound', async () => {
    const app: FakeApp = fakeApp({ model: scriptedModelPort({ script: { thinking: THINKING, reply: REPLY } }) })
    const setup = await testRender(<App app={app} opened={await spokenIn(app)} />, {
      width: 140,
      height: 40,
    })

    try {
      await setup.flush()
      await settle(250)

      await pressCtrlB(setup)
      await settle(250)

      expect(setup.captureCharFrame()).toContain(SIDEBAR_MARK)
      expect(contentColumnWidth(setup)).toBe(140 - SIDEBAR_WIDTH)
    } finally {
      await teardown(setup)
    }
  }, 60_000)

  it('closes the overlay on escape', async () => {
    const app: FakeApp = fakeApp({ model: scriptedModelPort({ script: { thinking: THINKING, reply: REPLY } }) })
    const setup = await testRender(<App app={app} opened={await spokenIn(app)} />, {
      width: NARROW,
      height: 40,
    })

    try {
      await setup.flush()
      await settle(250)
      await setup.flush()

      await pressCtrlB(setup)
      await settle(250)
      expect(setup.captureCharFrame()).toContain(SIDEBAR_MARK)

      setup.mockInput.pressEscape()
      await setup.flush()
      await settle(250)

      expect(setup.captureCharFrame()).not.toContain(SIDEBAR_MARK)
    } finally {
      await teardown(setup)
    }
  }, 60_000)

  it('dims what it floats over, so the sidebar reads as covering the transcript', async () => {
    const app: FakeApp = fakeApp({ model: scriptedModelPort({ script: { thinking: THINKING, reply: REPLY } }) })
    const setup = await testRender(<App app={app} opened={await spokenIn(app)} />, {
      width: NARROW,
      height: 40,
    })

    try {
      await setup.flush()
      await settle(250)
      await setup.flush()

      const uncovered = groundsAcross({ frame: setup.captureSpans(), needle: PLACEHOLDER })

      await pressCtrlB(setup)
      await settle(250)

      const covered = groundsAcross({ frame: setup.captureSpans(), needle: PLACEHOLDER })
      expect(covered[4]).not.toBe(uncovered[4])
    } finally {
      await teardown(setup)
    }
  }, 60_000)

  it('folds where the reader set it to rather than at the shipped width', async () => {
    const app: FakeApp = fakeApp({
      model: scriptedModelPort({ script: { thinking: THINKING, reply: REPLY } }),
      settings: { values: { [ESettingId.SidebarFoldBelow]: 90 } },
    })
    const setup = await testRender(<App app={app} opened={await spokenIn(app)} />, {
      width: 100,
      height: 40,
    })

    try {
      await setup.flush()
      await settle(250)
      await setup.flush()

      expect(setup.captureCharFrame()).toContain(SIDEBAR_MARK)
      expect(contentColumnWidth(setup)).toBe(100 - SIDEBAR_WIDTH)
    } finally {
      await teardown(setup)
    }
  }, 60_000)

  /**
   * An unclamped panel is laid out from `terminal - 42`, so its wordmark sits at a negative column
   * and never reaches the screen. Reading it back is what tells the two apart.
   */
  it('keeps the floating sidebar inside a terminal narrower than the sidebar', async () => {
    const app: FakeApp = fakeApp({ model: scriptedModelPort({ script: { thinking: THINKING, reply: REPLY } }) })
    const setup = await testRender(<App app={app} opened={await spokenIn(app)} />, {
      width: 30,
      height: 40,
    })

    try {
      await setup.flush()
      await settle(250)
      await setup.flush()

      await pressCtrlB(setup)
      await settle(250)

      expect(setup.captureCharFrame()).toContain(SIDEBAR_MARK)
    } finally {
      await teardown(setup)
    }
  }, 60_000)

  it('comes back on widening after a narrow peek was opened and closed', async () => {
    const app: FakeApp = fakeApp({ model: scriptedModelPort({ script: { thinking: THINKING, reply: REPLY } }) })
    const setup = await testRender(<App app={app} opened={await spokenIn(app)} />, {
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

  it('folds away when the terminal narrows under a docked sidebar', async () => {
    const app: FakeApp = fakeApp({ model: scriptedModelPort({ script: { thinking: THINKING, reply: REPLY } }) })
    const setup = await testRender(<App app={app} opened={await spokenIn(app)} />, {
      width: WIDE,
      height: 40,
    })

    try {
      await setup.flush()
      await settle(250)
      await setup.flush()

      expect(setup.captureCharFrame()).toContain(SIDEBAR_MARK)

      await resizeTo({ setup, width: NARROW })

      expect(setup.captureCharFrame()).not.toContain(SIDEBAR_MARK)
    } finally {
      await teardown(setup)
    }
  }, 60_000)

  it('lays the transcript out beside the sidebar once a narrow peek is widened', async () => {
    const app: FakeApp = fakeApp({ model: scriptedModelPort({ script: { thinking: THINKING, reply: REPLY } }) })
    const setup = await testRender(<App app={app} opened={await spokenIn(app)} />, {
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
