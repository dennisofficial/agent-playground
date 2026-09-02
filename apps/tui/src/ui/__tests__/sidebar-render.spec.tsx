import { homedir } from 'node:os'

import { EAgentStatus, ERetryReason, ERiskDimension, toCallId } from '@dltech/atlas-core'
import { parseColor, type RGBA } from '@opentui/core'
import { testRender } from '@opentui/react/test-utils'
import { describe, expect, it } from 'bun:test'
import React, { act } from 'react'

import { ESpendReading, SPEND_UNAVAILABLE } from '../../store/agent-spend'
import { ESidebarTaskState, IDLE_SIDEBAR, type SidebarModel } from '../../store/sidebar-model'
import { type SidebarSubagent } from '../../store/subagent-row'
import type { SidebarSection } from '../sidebar-section'
import { Sidebar } from '../components/sidebar'
import { SIDEBAR_GUTTER } from '../components/sidebar/cells'
import { IDLE_TURN, type TurnClock } from '../components/transcript'
import { teardown } from '../markdown/__tests__/harness'
import { ESidebarPlace } from '../sidebar-section'
import { glyph, SPINNER_FRAMES, SIDEBAR_WIDTH, theme } from '../theme'

const TERMINAL_WIDTH = 80

const HEIGHT = 44

const CWD = '/Users/dennis/Developer/atlas/apps/tui'

const WORDMARK = '● atlas'

const CONTENT_END = SIDEBAR_WIDTH - SIDEBAR_GUTTER

const THUMB = /[█▀▄]/

const OVERFLOWING_HEIGHT = 20

const BARELY_OVERFLOWING_HEIGHT = 36

const MANY_TASKS = Array.from({ length: 30 }, (_, task) => ({
  id: `m${task}`,
  label: `task ${task}`,
  state: ESidebarTaskState.Pending,
}))

const RUNNING: TurnClock = {
  startedAt: 1_000,
  outputTokens: 1_280,
  interrupting: false,
  reasoning: false,
  completed: null,
  retry: null,
}

const TASKS = [
  { id: 'k1', label: 'Revocation store on jti', state: ESidebarTaskState.Done },
  { id: 'k2', label: 'Issue and rotate a pair', state: ESidebarTaskState.Done },
  { id: 'k3', label: 'Cover rotation and reuse', state: ESidebarTaskState.Running },
  { id: 'k4', label: 'Reject a revoked jti', state: ESidebarTaskState.Pending },
  { id: 'k5', label: 'Drop the old column', state: ESidebarTaskState.Pending },
] as const

const PR_URL = 'https://github.com/o/r/pull/412'

const opened: string[] = []

const githubSection = (args: { pullRequest: boolean; checks: boolean }): SidebarSection => ({
  id: 'github',
  place: ESidebarPlace.Facts,
  rows: [
    { id: 'branch', spans: [{ text: 'auth/rotation' }] },
    {
      id: 'pull-request',
      spans: [
        ...(args.pullRequest ? [{ text: '#412 draft' }] : []),
        ...(args.pullRequest && args.checks ? [{ text: '  ' }] : []),
        ...(args.checks ? [{ text: `${SPINNER_FRAMES[0]} 2 running  3 ✓  1 ✗` }] : []),
      ],
      onActivate: () => opened.push(PR_URL),
    },
  ],
})

const FED: SidebarModel = {
  title: 'Refresh-token rotation',
  turnCount: 14,
  totalTokens: 22_400,
  approvals: [{ callId: toCallId('call-a'), reason: 'runs a shell command' }],
  lastActivity: null,
  liveOutputTokens: 1_280,
  lastTurnOutputTokens: null,
  sections: [githubSection({ pullRequest: true, checks: true })],
  todo: TASKS,
  subagents: [
    {
      id: 's1',
      name: 'test-writer',
      status: EAgentStatus.Running,
      calls: 41,
      lastTool: 'edit',
      startedAt: '2026-01-01T00:00:00.000Z',
      endedAt: null,
      state: 'edit · 1m 4s',
      spend: {
        reading: ESpendReading.Counted,
        totals: {
          turns: 6,
          steps: 12,
          inputTokens: 48_200,
          outputTokens: 3_100,
          cacheReadTokens: 41_000,
          cacheWriteTokens: 2_000,
        },
      },
      selected: false,
    },
    {
      id: 's2',
      name: 'migration',
      status: EAgentStatus.Blocked,
      calls: 3,
      lastTool: 'bash',
      startedAt: '2026-01-01T00:00:00.000Z',
      endedAt: null,
      state: 'blocked · 12s',
      spend: SPEND_UNAVAILABLE,
      selected: false,
    },
  ],
  teammates: [
    { id: 't1', name: 'dana', activity: 'reviewing #412' },
    { id: 't2', name: 'omar', activity: null },
  ],
}

const MEASURED: SidebarModel = {
  ...FED,
  subagents: [
    {
      ...(FED.subagents?.[0] as SidebarSubagent),
      context: { tokens: 68_000, window: 200_000 },
    },
  ],
}

async function rowsOf(args: {
  model: SidebarModel
  turn?: TurnClock
  height?: number
  root?: string
  worktree?: string | null
  width?: number
}): Promise<string[]> {
  const height = args.height ?? HEIGHT
  const setup = await testRender(
    <box flexDirection="row" width={TERMINAL_WIDTH} height={height}>
      <Sidebar
        width={args.width ?? SIDEBAR_WIDTH}
        model={args.model}
        turn={args.turn ?? RUNNING}
        now={42_000}
        root={args.root ?? CWD}
        worktree={args.worktree ?? null}
      />
    </box>,
    { width: TERMINAL_WIDTH, height },
  )

  try {
    await setup.flush()
    return setup.captureCharFrame().split('\n')
  } finally {
    await teardown(setup)
  }
}

const without = (fact: 'pullRequest' | 'checks'): SidebarModel => ({
  ...FED,
  sections: [githubSection({ pullRequest: fact !== 'pullRequest', checks: fact !== 'checks' })],
})

const rowWith = (args: { rows: readonly string[]; text: string }): string =>
  args.rows.find((row) => row.includes(args.text)) ?? ''

const written = (row: string): string => row.slice(0, CONTENT_END)

const trackHeight = (setup: Awaited<ReturnType<typeof testRender>>): number => {
  const scroller = setup.renderer.root.getChildren()[0]?.getChildren()[0]?.getChildren()[0]
  if (scroller === undefined) throw new Error('the sidebar scrollbox never mounted')

  return scroller.height
}

describe('the scroll gutter', () => {
  it('runs the scrollbar down the last column, a clear gutter away from the text', async () => {
    const rows = await rowsOf({ model: FED, height: OVERFLOWING_HEIGHT })

    const track = rows.filter((row) => THUMB.test(row.slice(SIDEBAR_WIDTH - 1, SIDEBAR_WIDTH)))
    expect(track.length).toBeGreaterThan(0)

    for (const row of rows) expect(row.slice(CONTENT_END, SIDEBAR_WIDTH - 1).trim()).toBe('')
  }, 30_000)

  it('fills nearly the whole track when nearly the whole panel is on screen', async () => {
    const setup = await testRender(
      <box flexDirection="row" width={TERMINAL_WIDTH} height={BARELY_OVERFLOWING_HEIGHT}>
        <Sidebar
          width={SIDEBAR_WIDTH}
          model={{ ...IDLE_SIDEBAR, title: 'Barely over', todo: MANY_TASKS }}
          turn={IDLE_TURN}
          now={42_000}
          root={CWD}
          worktree={null}
        />
      </box>,
      { width: TERMINAL_WIDTH, height: BARELY_OVERFLOWING_HEIGHT },
    )

    try {
      await setup.flush()
      const track = trackHeight(setup)
      const thumb = setup
        .captureCharFrame()
        .split('\n')
        .filter((row) => THUMB.test(row.slice(SIDEBAR_WIDTH - 1, SIDEBAR_WIDTH))).length

      expect(thumb).toBeGreaterThan(track * 0.8)
    } finally {
      await teardown(setup)
    }
  }, 30_000)
})

describe('the checklist', () => {
  it('marks the running task without animating it, so an idle sidebar holds still', async () => {
    const rows = await rowsOf({ model: FED, turn: IDLE_TURN })
    const running = rowWith({ rows, text: 'Cover rotation and reuse' })

    expect(running).toContain(glyph.marker)
    for (const frame of SPINNER_FRAMES) expect(running).not.toContain(frame)
  })

  it('soft-wraps a task too long for the column instead of clipping it', async () => {
    const model: SidebarModel = {
      ...FED,
      todo: [
        {
          id: 'k9',
          label: 'Soft-wrap the sidebar task text instead of truncating it',
          state: ESidebarTaskState.Pending,
        },
      ],
    }

    const rows = await rowsOf({ model, turn: IDLE_TURN })

    expect(rowWith({ rows, text: 'Soft-wrap the' })).not.toContain('…')
    expect(rowWith({ rows, text: 'truncating it' })).not.toBe('')
  })

  it('says what it is doing in place of the task it is doing', async () => {
    const model: SidebarModel = {
      ...FED,
      todo: [
        {
          id: 'k9',
          label: 'Fix the bug',
          state: ESidebarTaskState.Running,
          activeForm: 'Fixing the bug',
        },
      ],
    }

    const rows = await rowsOf({ model, turn: IDLE_TURN })

    expect(rowWith({ rows, text: 'Fixing the bug' })).not.toBe('')
    expect(rowWith({ rows, text: 'Fix the bug' })).toBe('')
  })
})

describe('what the sidebar says', () => {
  it('keeps every row inside its own column', async () => {
    const rows = await rowsOf({ model: FED })

    for (const row of rows) expect(row.slice(SIDEBAR_WIDTH).trim()).toBe('')
  }, 30_000)

  it('draws no section header for a section nothing feeds', async () => {
    const rows = await rowsOf({ model: IDLE_SIDEBAR, turn: IDLE_TURN })
    const frame = rows.join('\n')

    for (const header of ['TURN', 'APPROVALS', 'TODO', 'SUBAGENTS', 'TEAMMATES'])
      expect(frame).not.toContain(header)

    expect(frame).not.toContain('turns')
    expect(frame).toContain(WORDMARK)
  }, 30_000)

  it('names the session and what it has cost, and leaves the model to the footer', async () => {
    const rows = await rowsOf({ model: FED })
    const frame = rows.join('\n')

    expect(frame).toContain('Refresh-token rotation')
    expect(frame).toContain('14 turns · 22.4k tokens')
    expect(frame).not.toContain('claude-')
    expect(frame).not.toContain('branch rotation')
  }, 30_000)

  it('sets a fact against the right edge of the column', async () => {
    const rows = await rowsOf({ model: FED })
    const git = rowWith({ rows, text: 'auth/rotation' })

    expect(git.trimStart().startsWith('auth/rotation')).toBe(true)
    expect(written(git).trimEnd().endsWith('auth/rotation')).toBe(true)
    expect(written(git).trimEnd().length).toBe(CONTENT_END)
  }, 30_000)

  it('spells the pull request and its checks on one unlabelled line', async () => {
    const rows = await rowsOf({ model: FED })
    const repository = rowWith({ rows, text: '#412 draft' })

    expect(repository).toContain('2 running')
    expect(repository).toContain('3 ✓')
    expect(repository).toContain('1 ✗')
    expect(rowWith({ rows, text: '3 ✓' })).toBe(repository)
  }, 30_000)

  it('carries no pr or ci label, and sets the line against the right edge', async () => {
    const rows = await rowsOf({ model: FED })
    const repository = written(rowWith({ rows, text: '#412 draft' }))

    expect(repository.trimStart().startsWith('#412')).toBe(true)
    expect(repository.trimEnd().length).toBe(CONTENT_END)
  }, 30_000)

  it('keeps the whole line at the width the sidebar actually ships with', async () => {
    const rows = await rowsOf({ model: FED })
    const repository = rowWith({ rows, text: '#412 draft' })

    expect(repository).toContain('2 running')
    expect(repository).toContain('1 ✗')
  }, 30_000)

  it('shows the pull request alone when nothing has reported a check', async () => {
    const rows = await rowsOf({ model: without('checks') })
    const repository = rowWith({ rows, text: '#412 draft' })

    expect(repository).toContain('draft')
    expect(repository).not.toContain('✓')
  }, 30_000)

  it('shows the checks alone if they ever arrive without a pull request', async () => {
    const rows = await rowsOf({ model: without('pullRequest') })
    const checks = rowWith({ rows, text: '3 ✓' })

    expect(checks).toContain('1 ✗')
    expect(checks).not.toContain('#')
  }, 30_000)

  it('opens the pull request when its row is clicked', async () => {
    opened.length = 0
    const setup = await testRender(
      <box flexDirection="row" width={TERMINAL_WIDTH} height={HEIGHT}>
        <Sidebar
          width={SIDEBAR_WIDTH}
          model={FED}
          turn={RUNNING}
          now={42_000}
          root={CWD}
          worktree={null}
        />
      </box>,
      { width: TERMINAL_WIDTH, height: HEIGHT },
    )

    try {
      await setup.flush()
      const rows = setup.captureCharFrame().split('\n')
      const row = rows.findIndex((line) => line.includes('#412 draft'))
      const column = (rows[row] ?? '').indexOf('#412')

      expect(row).toBeGreaterThanOrEqual(0)

      await act(async () => {
        await setup.mockMouse.click(column, row)
      })
      await setup.flush()

      expect(opened).toEqual([PR_URL])
    } finally {
      await teardown(setup)
    }
  }, 30_000)

  it('washes the pull request row under the pointer, and only that row', async () => {
    const setup = await testRender(
      <box flexDirection="row" width={TERMINAL_WIDTH} height={HEIGHT}>
        <Sidebar
          width={SIDEBAR_WIDTH}
          model={FED}
          turn={RUNNING}
          now={42_000}
          root={CWD}
          worktree={null}
        />
      </box>,
      { width: TERMINAL_WIDTH, height: HEIGHT },
    )

    try {
      await setup.flush()
      const rows = setup.captureCharFrame().split('\n')
      const pullRequest = rows.findIndex((line) => line.includes('#412 draft'))
      const branch = rows.findIndex((line) => line.includes('auth/rotation'))
      const column = (rows[pullRequest] ?? '').indexOf('#412')

      const groundAt = (row: number): RGBA | undefined => {
        let at = 0
        for (const span of setup.captureSpans().lines[row]?.spans ?? []) {
          at += [...span.text].length
          if (column < at) return span.bg
        }
        return undefined
      }

      const hoverBg = parseColor(theme.hoverBg)

      expect(groundAt(pullRequest)?.equals(hoverBg) ?? false).toBe(false)

      await act(async () => {
        await setup.mockMouse.moveTo(column, pullRequest)
      })
      await setup.flush()

      expect(groundAt(pullRequest)?.equals(hoverBg)).toBe(true)
      expect(groundAt(branch)?.equals(hoverBg) ?? false).toBe(false)

      await act(async () => {
        await setup.mockMouse.moveTo(column, branch)
      })
      await setup.flush()

      expect(groundAt(pullRequest)?.equals(hoverBg) ?? false).toBe(false)
    } finally {
      await teardown(setup)
    }
  }, 30_000)

  it('leaves the branch alone, which has nothing to open', async () => {
    opened.length = 0
    const setup = await testRender(
      <box flexDirection="row" width={TERMINAL_WIDTH} height={HEIGHT}>
        <Sidebar
          width={SIDEBAR_WIDTH}
          model={FED}
          turn={RUNNING}
          now={42_000}
          root={CWD}
          worktree={null}
        />
      </box>,
      { width: TERMINAL_WIDTH, height: HEIGHT },
    )

    try {
      await setup.flush()
      const rows = setup.captureCharFrame().split('\n')
      const row = rows.findIndex((line) => line.includes('auth/rotation'))
      const column = (rows[row] ?? '').indexOf('auth/rotation')

      await act(async () => {
        await setup.mockMouse.click(column, row)
      })
      await setup.flush()

      expect(opened).toEqual([])
    } finally {
      await teardown(setup)
    }
  }, 30_000)

  it('counts the plan off and marks each task by its state', async () => {
    const rows = await rowsOf({ model: FED })

    expect(rowWith({ rows, text: 'TODO' })).toContain('2/5')
    expect(rowWith({ rows, text: 'Revocation store' })).toContain('✓ Revocation store on jti')
    expect(rowWith({ rows, text: 'Reject a revoked' })).toContain('○ Reject a revoked jti')
    expect(rowWith({ rows, text: 'Cover rotation' }).trim().startsWith('✓')).toBe(false)
  }, 30_000)

  it('says what each subagent and teammate is doing', async () => {
    const rows = await rowsOf({ model: FED })

    expect(rowWith({ rows, text: 'SUBAGENTS' })).toContain('2')
    expect(rowWith({ rows, text: 'test-writer' })).toContain('edit · 1m 4s')
    expect(rowWith({ rows, text: 'migration' })).toContain('blocked · 12s')
    expect(rowWith({ rows, text: 'dana' })).toContain('reviewing #412')
    expect(rowWith({ rows, text: 'omar' })).toContain('idle')
  }, 30_000)

  /**
   * A child's approval routes to the parent agent and never to a human, so the row must not offer
   * the operator a prompt they cannot answer. It says what happened and marks itself for attention.
   */
  it('flags a blocked child for attention without inviting an answer it cannot take', async () => {
    const rows = await rowsOf({ model: FED })
    const blocked = rowWith({ rows, text: 'migration' })

    expect(blocked).toContain('blocked')
    expect(blocked).not.toContain('approval')
    expect(blocked.trim().startsWith(glyph.warning)).toBe(true)
  }, 30_000)

  it('leaves a running child unmarked by the attention glyph a blocked one carries', async () => {
    const rows = await rowsOf({ model: FED })

    expect(rowWith({ rows, text: 'test-writer' }).trim().startsWith(glyph.warning)).toBe(false)
  }, 30_000)

  it('gives a child a second line carrying what it spent, in both directions', async () => {
    const rows = await rowsOf({ model: FED })

    expect(rowWith({ rows, text: '↑ 48.2k' })).toContain('↓ 3.1k')
  }, 30_000)

  it('gives a measured child how full its own window has got, beside what it spent', async () => {
    const rows = await rowsOf({ model: MEASURED })

    expect(rowWith({ rows, text: '↑ 48.2k' })).toContain('ctx 34%')
  }, 30_000)

  it('keeps the spend off the line the name and state share', async () => {
    const rows = await rowsOf({ model: FED })

    expect(rowWith({ rows, text: 'test-writer' })).not.toContain('48.2k')
  }, 30_000)

  /**
   * Hung off the value column's own right edge rather than the panel's, so a crew of five stacks
   * its figures into a column rather than reading as ten unrelated lines.
   */
  it('ends the spend line on the same column the state above it ends on', async () => {
    const rows = await rowsOf({ model: FED })
    const state = written(rowWith({ rows, text: 'test-writer' })).trimEnd()
    const spend = written(rowWith({ rows, text: '↑ 48.2k' })).trimEnd()

    expect(spend.startsWith(' ')).toBe(true)
    expect(spend.endsWith('↓ 3.1k')).toBe(true)
    expect(spend.length).toBe(state.length)
  }, 30_000)

  it('ends on the same column as the state above once a third figure joins', async () => {
    const rows = await rowsOf({ model: MEASURED })
    const state = written(rowWith({ rows, text: 'test-writer' })).trimEnd()
    const figures = written(rowWith({ rows, text: '↑ 48.2k' })).trimEnd()

    expect(figures.startsWith(' ')).toBe(true)
    expect(figures.endsWith('ctx 34%')).toBe(true)
    expect(figures.length).toBe(state.length)
  }, 30_000)

  it('draws nothing at all for a child nothing has measured', async () => {
    const rows = await rowsOf({ model: FED })

    expect(rowWith({ rows, text: '↑ 48.2k' })).not.toContain('ctx')
  }, 30_000)

  /**
   * The child's own window is the reading most tempting to pool with the parent's, and the parent's
   * count sits four rows above it.
   */
  it('leaves the parent count untouched by how full the child window has got', async () => {
    const frame = (await rowsOf({ model: MEASURED })).join('\n')

    expect(frame).toContain('ctx 34%')
    expect(frame).toContain('14 turns · 22.4k tokens')
    expect(frame).not.toContain('90.4k')
  }, 30_000)

  it('right-aligns the missing reading too, so it reads as a row and not a mistake', async () => {
    const rows = await rowsOf({ model: FED })
    const state = written(rowWith({ rows, text: 'test-writer' })).trimEnd()
    const missing = written(rowWith({ rows, text: 'tokens unavailable' })).trimEnd()

    expect(missing.endsWith('tokens unavailable')).toBe(true)
    expect(missing.length).toBe(state.length)
  }, 30_000)

  it('says a reading is missing rather than showing a child as free', async () => {
    const rows = await rowsOf({ model: FED })

    expect(rows.join('\n')).toContain('tokens unavailable')
    expect(rowWith({ rows, text: 'tokens unavailable' })).not.toContain('0')
  }, 30_000)

  /**
   * The context meter answers for this conversation's window. A child's window is a different one,
   * and the row beneath it must never be read into the number above it.
   */
  it('leaves the parent context meter untouched by what the crew spent', async () => {
    const rows = await rowsOf({ model: FED })
    const frame = rows.join('\n')

    expect(frame).toContain('↑ 48.2k')
    expect(frame).not.toContain('51.3k')
    expect(frame).not.toContain('60.7k')
  }, 30_000)

  it('keeps the live turn in view', async () => {
    const rows = await rowsOf({ model: FED })
    const frame = rows.join('\n')

    expect(frame).toContain('TURN')
    expect(rowWith({ rows, text: 'working' })).toContain('41s')
  }, 30_000)

  it('says nothing about the classifier, which does not belong in the column', async () => {
    const frame = (await rowsOf({ model: FED })).join('\n')

    expect(frame).not.toContain('APPROVALS')
    expect(frame).not.toContain('pauses')
  }, 30_000)

  it('calls a stalled turn retrying rather than working', async () => {
    const rows = await rowsOf({
      model: FED,
      turn: {
        ...RUNNING,
        retry: {
          attempt: 3,
          maxAttempts: 10,
          delayMs: 8_000,
          reason: ERetryReason.RateLimited,
          startedAt: 40_000,
        },
      },
    })

    expect(rowWith({ rows, text: 'retrying' })).toContain('41s')
    expect(rows.join('\n')).not.toContain('working')
  }, 30_000)

  it('pins where it is running to the bottom of the column', async () => {
    const rows = await rowsOf({ model: FED })
    const wordmark = rows.findIndex((row) => row.trimStart().startsWith(WORDMARK))

    expect(wordmark).toBeGreaterThan(rows.findIndex((row) => row.includes('TEAMMATES')))
    expect(rows.length - wordmark).toBeLessThanOrEqual(3)
    expect(rows[wordmark - 1]).toContain('Developer/atlas/apps/tui')
  }, 30_000)

  it('truncates a title too long for the column rather than wrapping it', async () => {
    const long = 'Rotate every refresh token, then reject the reused ones without mercy'
    const rows = await rowsOf({ model: { ...FED, title: long } })
    const frame = rows.join('\n')

    expect(frame).toContain('…')
    expect(frame).not.toContain('without mercy')
    expect(rowWith({ rows, text: '14 turns' })).toBeTruthy()
  }, 30_000)
})

type OverlayHandle = { flip: (next: boolean) => void }

function Beside(props: { handle: OverlayHandle }): React.ReactNode {
  const [overlay, setOverlay] = React.useState(true)
  props.handle.flip = setOverlay

  return (
    <box flexDirection="row" width={TERMINAL_WIDTH} height={HEIGHT}>
      <box flexGrow={1} flexShrink={1} flexBasis={0} />
      <Sidebar
        width={SIDEBAR_WIDTH}
        model={FED}
        turn={RUNNING}
        now={42_000}
        root={CWD}
        worktree={null}
        overlay={overlay}
      />
    </box>
  )
}

const columnWidth = (setup: Awaited<ReturnType<typeof testRender>>): number => {
  const column = setup.renderer.root.getChildren()[0]?.getChildren()[0]
  if (column === undefined) throw new Error('the content column never mounted')

  return column.width
}

describe('the column beside the sidebar', () => {
  it('keeps the whole terminal for the content while the sidebar floats over it', async () => {
    const handle: OverlayHandle = { flip: () => {} }
    const setup = await testRender(<Beside handle={handle} />, {
      width: TERMINAL_WIDTH,
      height: HEIGHT,
    })

    try {
      await setup.flush()

      expect(columnWidth(setup)).toBe(TERMINAL_WIDTH)
    } finally {
      await teardown(setup)
    }
  }, 30_000)

  it('hands the content back its share once the sidebar stops floating', async () => {
    const handle: OverlayHandle = { flip: () => {} }
    const setup = await testRender(<Beside handle={handle} />, {
      width: TERMINAL_WIDTH,
      height: HEIGHT,
    })

    try {
      await setup.flush()
      handle.flip(false)
      await setup.flush()

      expect(columnWidth(setup)).toBe(TERMINAL_WIDTH - SIDEBAR_WIDTH)
    } finally {
      await teardown(setup)
    }
  }, 30_000)
})

describe('the footer', () => {
  const REPOSITORY = `${homedir()}/Developer/comp-v3`

  it('names the repository alone when the session is not in a worktree', async () => {
    const rows = await rowsOf({ model: IDLE_SIDEBAR, root: REPOSITORY })
    const mark = rows.findIndex((row) => row.includes('● atlas'))

    expect(written(rows[mark - 1] ?? '').trim()).toBe('~/Developer/comp-v3')
  }, 30_000)

  it('hangs the worktree under the repository, relative to it', async () => {
    const rows = await rowsOf({
      model: IDLE_SIDEBAR,
      root: REPOSITORY,
      worktree: `${REPOSITORY}/.claude/worktrees/portal-auth-url`,
    })
    const mark = rows.findIndex((row) => row.includes('● atlas'))

    expect(written(rows[mark - 2] ?? '').trim()).toBe('~/Developer/comp-v3')
    expect(written(rows[mark - 1] ?? '').trim()).toBe('.claude/worktrees/portal-auth-url')
  }, 30_000)

  it('compacts a long path by segment rather than cutting its head off', async () => {
    const rows = await rowsOf({
      model: IDLE_SIDEBAR,
      root: `${homedir()}/Developer/organisation/platform/services/gateway`,
    })
    const mark = rows.findIndex((row) => row.includes('● atlas'))
    const shown = written(rows[mark - 1] ?? '').trim()

    expect(shown).toBe('~/D/o/platform/services/gateway')
    expect(shown).not.toContain('…')
  }, 30_000)
})

describe('a section a plugin contributed', () => {
  it('draws its rows where the plugin placed them', async () => {
    const rows = await rowsOf({
      model: {
        ...IDLE_SIDEBAR,
        title: 'Refresh-token rotation',
        sections: [
          {
            id: 'deploys',
            place: ESidebarPlace.Panels,
            label: 'deploys',
            rows: [{ id: 'staging', spans: [{ text: 'staging green' }] }],
          },
        ],
      },
    })

    expect(rowWith({ rows, text: 'DEPLOYS' })).toContain('DEPLOYS')
    expect(rowWith({ rows, text: 'staging green' })).toContain('staging green')
  })

  it('draws nothing at all when no plugin contributed one', async () => {
    const rows = await rowsOf({ model: { ...IDLE_SIDEBAR, title: 'Refresh-token rotation' } })

    expect(rows.some((row) => row.includes('DEPLOYS'))).toBe(false)
  })
})
