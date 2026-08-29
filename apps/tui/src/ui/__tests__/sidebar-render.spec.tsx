import { toCallId } from '@dltech/atlas-core'
import { testRender } from '@opentui/react/test-utils'
import { describe, expect, it } from 'bun:test'
import React from 'react'

import { ESidebarTaskState, IDLE_SIDEBAR, type SidebarModel } from '../../store/sidebar-model'
import { Sidebar } from '../components/sidebar'
import { IDLE_TURN, type TurnClock } from '../components/transcript'
import { teardown } from '../markdown/__tests__/harness'
import { SIDEBAR_WIDTH } from '../theme'

const TERMINAL_WIDTH = 80

const HEIGHT = 44

const CWD = '/Users/dennis/Developer/atlas/apps/tui'

const WORDMARK = '● atlas'

const SCROLLBAR_COLUMN = SIDEBAR_WIDTH - 3

const RUNNING: TurnClock = {
  startedAt: 1_000,
  outputTokens: 1_280,
  interrupting: false,
  completed: null,
}

const TASKS = [
  { id: 'k1', label: 'Revocation store on jti', state: ESidebarTaskState.Done },
  { id: 'k2', label: 'Issue and rotate a pair', state: ESidebarTaskState.Done },
  { id: 'k3', label: 'Cover rotation and reuse', state: ESidebarTaskState.Running },
  { id: 'k4', label: 'Reject a revoked jti', state: ESidebarTaskState.Pending },
  { id: 'k5', label: 'Drop the old column', state: ESidebarTaskState.Pending },
] as const

const FED: SidebarModel = {
  title: 'Refresh-token rotation',
  turnCount: 14,
  totalTokens: 22_400,
  approvals: [{ callId: toCallId('call-a'), reason: 'runs a shell command' }],
  toolCalls: [{ callId: toCallId('call-b'), name: 'read_file' }],
  lastActivity: null,
  liveOutputTokens: 1_280,
  lastTurnOutputTokens: null,
  git: { branch: 'auth/rotation' },
  pr: { number: 412, state: 'draft' },
  ci: { running: 2, passed: 3, failed: 1 },
  todo: TASKS,
  subagents: [
    { id: 's1', name: 'test-writer', calls: 41, awaitingApproval: false },
    { id: 's2', name: 'migration', calls: 3, awaitingApproval: true },
  ],
  teammates: [
    { id: 't1', name: 'dana', activity: 'reviewing #412' },
    { id: 't2', name: 'omar', activity: null },
  ],
}

async function rowsOf(args: { model: SidebarModel; turn?: TurnClock }): Promise<string[]> {
  const setup = await testRender(
    <box flexDirection="row" width={TERMINAL_WIDTH} height={HEIGHT}>
      <Sidebar
        width={SIDEBAR_WIDTH}
        model={args.model}
        turn={args.turn ?? RUNNING}
        now={42_000}
        cwd={CWD}
      />
    </box>,
    { width: TERMINAL_WIDTH, height: HEIGHT },
  )

  try {
    await setup.flush()
    return setup.captureCharFrame().split('\n')
  } finally {
    await teardown(setup)
  }
}

const rowWith = (args: { rows: readonly string[]; text: string }): string =>
  args.rows.find((row) => row.includes(args.text)) ?? ''

const written = (row: string): string => row.slice(0, SCROLLBAR_COLUMN)

describe('what the sidebar says', () => {
  it('keeps every row inside its own column', async () => {
    const rows = await rowsOf({ model: FED })

    for (const row of rows) expect(row.slice(SIDEBAR_WIDTH).trim()).toBe('')
  }, 30_000)

  it('draws no section header for a section nothing feeds', async () => {
    const rows = await rowsOf({ model: IDLE_SIDEBAR, turn: IDLE_TURN })
    const frame = rows.join('\n')

    for (const header of ['TURN', 'APPROVALS', 'TOOL CALLS', 'TODO', 'SUBAGENTS', 'TEAMMATES'])
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

    expect(git.trimStart().startsWith('git')).toBe(true)
    expect(written(git).trimEnd().endsWith('auth/rotation')).toBe(true)
    expect(written(git).trimEnd().length).toBe(SCROLLBAR_COLUMN)
  }, 30_000)

  it('spells the pull request and what its checks are doing', async () => {
    const rows = await rowsOf({ model: FED })

    expect(rowWith({ rows, text: '#412' })).toContain('draft')

    const ci = rowWith({ rows, text: 'running' })
    expect(ci).toContain('2 running')
    expect(ci).toContain('3 ✓')
    expect(ci).toContain('1 ✗')
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
    expect(rowWith({ rows, text: 'test-writer' })).toContain('41 calls')
    expect(rowWith({ rows, text: 'migration' })).toContain('? approval')
    expect(rowWith({ rows, text: 'dana' })).toContain('reviewing #412')
    expect(rowWith({ rows, text: 'omar' })).toContain('idle')
  }, 30_000)

  it('keeps the live turn, the approval and the pending call in view', async () => {
    const rows = await rowsOf({ model: FED })
    const frame = rows.join('\n')

    expect(frame).toContain('TURN')
    expect(rowWith({ rows, text: 'working' })).toContain('41s')
    expect(rowWith({ rows, text: 'APPROVALS' })).toContain('1')
    expect(frame).toContain('runs a shell command')
    expect(rowWith({ rows, text: 'TOOL CALLS' })).toContain('1')
    expect(frame).toContain('read_file')
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
        cwd={CWD}
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
