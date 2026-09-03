import { EShellStatus, toShellId, type ShellSnapshot } from '@dltech/atlas-harness'
import { testRender } from '@opentui/react/test-utils'
import { describe, expect, it } from 'bun:test'
import React from 'react'

import { IDLE_SIDEBAR } from '../../store/sidebar-model'
import { Shells } from '../components/shells'
import { Sidebar } from '../components/sidebar'
import { teardown } from '../markdown/__tests__/harness'
import { SIDEBAR_WIDTH } from '../theme'

const TERMINAL_WIDTH = 100

const HEIGHT = 44

const CWD = '/Users/dennis/Developer/atlas'

const PANEL_WIDTH = 72

const STARTED_AT = '2026-08-27T12:00:00.000Z'

const NOW = Date.parse(STARTED_AT) + 64_000

const shell = (over: Omit<Partial<ShellSnapshot>, 'shellId'> & { shellId: string }): ShellSnapshot =>
  ({
    command: 'bun test --watch',
    description: 'Watch the tests',
    status: EShellStatus.Running,
    pid: 4242,
    startedAt: STARTED_AT,
    lastOutputAt: STARTED_AT,
    totalCharacters: 0,
    awaitingInput: false,
    ...over,
    shellId: toShellId(over.shellId),
  })

async function framed(node: React.ReactNode): Promise<string[]> {
  const setup = await testRender(
    <box flexDirection="row" width={TERMINAL_WIDTH} height={HEIGHT}>
      {node}
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

const sidebarRows = (shells: readonly ShellSnapshot[]): Promise<string[]> =>
  framed(
    <Sidebar
      width={SIDEBAR_WIDTH}
      model={IDLE_SIDEBAR}
      root={CWD}
      worktree={null}
      shells={shells}
      shellNow={NOW}
    />,
  )

const panelRows = (args: {
  shells: readonly ShellSnapshot[]
  selected?: ShellSnapshot | undefined
  output?: string
}): Promise<string[]> =>
  framed(
    <Shells
      width={PANEL_WIDTH}
      shells={args.shells}
      now={NOW}
      selected={args.selected}
      output={args.output ?? ''}
      onKill={() => undefined}
      onDismiss={() => undefined}
    />,
  )

const has = (rows: readonly string[], text: string): boolean =>
  rows.some((row) => row.includes(text))

describe('what the sidebar says about background shells', () => {
  it('says nothing at all when the session has started none', async () => {
    const rows = await sidebarRows([])

    expect(has(rows, 'SHELLS')).toBe(false)
  })

  it('lists a running shell by the name the model gave it, with a count of what is live', async () => {
    const rows = await sidebarRows([shell({ shellId: 'bash_1' }), shell({ shellId: 'bash_2' })])

    expect(has(rows, 'SHELLS')).toBe(true)
    expect(has(rows, 'Watch the tests')).toBe(true)
    expect(has(rows, 'bun test --watch')).toBe(false)
    expect(has(rows, '2/2')).toBe(true)
  })

  it('falls back to the command for a shell replayed from before names were required', async () => {
    const rows = await sidebarRows([shell({ shellId: 'bash_1', description: '' })])

    expect(has(rows, 'bun test --watch')).toBe(true)
  })

  it('counts the finished ones out of the live tally but keeps them listed', async () => {
    const rows = await sidebarRows([
      shell({ shellId: 'bash_1' }),
      shell({
        shellId: 'bash_2',
        status: EShellStatus.Exited,
        exitCode: 0,
        description: 'Build the app',
      }),
    ])

    expect(has(rows, '1/2')).toBe(true)
    expect(has(rows, 'Build the app')).toBe(true)
  })

  it('marks a shell waiting on input, since that one will never finish on its own', async () => {
    const rows = await sidebarRows([shell({ shellId: 'bash_1', awaitingInput: true })])

    expect(has(rows, 'awaiting input')).toBe(true)
  })

  it('names a failing exit code rather than only saying it ended', async () => {
    const rows = await sidebarRows([
      shell({ shellId: 'bash_1', status: EShellStatus.Exited, exitCode: 2 }),
    ])

    expect(has(rows, 'exit 2')).toBe(true)
  })

  it('counts a running shell up from when it started', async () => {
    const rows = await sidebarRows([shell({ shellId: 'bash_1' })])

    expect(has(rows, 'running · 1m 4s')).toBe(true)
  })

  it('stops a finished shell at what it took rather than counting past its ending', async () => {
    const rows = await sidebarRows([
      shell({
        shellId: 'bash_1',
        status: EShellStatus.Exited,
        exitCode: 0,
        endedAt: '2026-08-27T12:00:12.000Z',
      }),
    ])

    expect(has(rows, 'done · 12s')).toBe(true)
  })
})

describe('what the shells panel shows', () => {
  it('says so in words when nothing is running', async () => {
    const rows = await panelRows({ shells: [] })

    expect(has(rows, 'Nothing is running in the background')).toBe(true)
  })

  it('names the shell whose log it is showing', async () => {
    const selected = shell({ shellId: 'bash_1' })
    const rows = await panelRows({ shells: [selected], selected })

    expect(has(rows, 'bash_1')).toBe(true)
    expect(has(rows, 'bun test --watch')).toBe(true)
  })

  it('leaves the listing to the sidebar rather than repeating it over the transcript', async () => {
    const selected = shell({ shellId: 'bash_1' })
    const other = shell({ shellId: 'bash_2', command: 'bun run dev' })
    const rows = await panelRows({ shells: [selected, other], selected })

    expect(has(rows, 'bash_1')).toBe(true)
    expect(has(rows, 'bash_2')).toBe(false)
    expect(has(rows, 'bun run dev')).toBe(false)
  })

  it('shows the selected shell output, newest lines last', async () => {
    const selected = shell({ shellId: 'bash_1', totalCharacters: 24 })
    const rows = await panelRows({
      shells: [selected],
      selected,
      output: 'first line\nsecond line\n',
    })

    expect(has(rows, 'OUTPUT')).toBe(true)
    expect(has(rows, 'second line')).toBe(true)
  })

  it('offers a way to stop a running shell', async () => {
    const selected = shell({ shellId: 'bash_1' })
    const rows = await panelRows({ shells: [selected], selected })

    expect(has(rows, 'stop it')).toBe(true)
  })

  it('offers no way to stop one that has already ended', async () => {
    const selected = shell({ shellId: 'bash_1', status: EShellStatus.Exited, exitCode: 0 })
    const rows = await panelRows({ shells: [selected], selected })

    expect(has(rows, 'stop it')).toBe(false)
  })

  it('says a shell has printed nothing rather than showing a blank pane', async () => {
    const selected = shell({ shellId: 'bash_1' })
    const rows = await panelRows({ shells: [selected], selected, output: '' })

    expect(has(rows, 'printed nothing yet')).toBe(true)
  })

  it('explains why a shell awaiting input cannot be waited on', async () => {
    const selected = shell({ shellId: 'bash_1', awaitingInput: true })
    const rows = await panelRows({ shells: [selected], selected, output: 'Password: ' })

    expect(has(rows, 'stdin is closed')).toBe(true)
  })

  it('names the keys that walk it', async () => {
    const rows = await panelRows({ shells: [shell({ shellId: 'bash_1' })] })

    expect(has(rows, 'kill')).toBe(true)
    expect(has(rows, 'close')).toBe(true)
  })
})

const LOUD_LINES = 200

const loud = Array.from({ length: LOUD_LINES }, (_, index) => `line ${index + 1}`).join('\n')

const printedLines = (frame: string): readonly number[] =>
  [...frame.matchAll(/line (\d+)/g)].map((match) => Number(match[1]))

describe('the scrollback the panel keeps', () => {
  it('holds the older output behind the wheel rather than throwing it away', async () => {
    const setup = await testRender(
      <box flexDirection="row" width={TERMINAL_WIDTH} height={HEIGHT}>
        <Shells
          width={PANEL_WIDTH}
          shells={[shell({ shellId: 'bash_1' })]}
          now={NOW}
          selected={shell({ shellId: 'bash_1' })}
          output={loud}
          onKill={() => undefined}
          onDismiss={() => undefined}
        />
      </box>,
      { width: TERMINAL_WIDTH, height: HEIGHT },
    )

    try {
      await setup.flush()
      const settled = printedLines(setup.captureCharFrame())

      expect(settled).toContain(LOUD_LINES)

      await setup.mockMouse.scroll(10, 20, 'up')
      await setup.flush()

      const walked = printedLines(setup.captureCharFrame())

      expect(Math.min(...walked)).toBeLessThan(Math.min(...settled))
    } finally {
      await teardown(setup)
    }
  })
})
