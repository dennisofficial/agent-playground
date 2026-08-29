import { testRender } from '@opentui/react/test-utils'
import { describe, expect, it } from 'bun:test'
import React from 'react'

import { Startup } from '../components/startup'
import { teardown } from '../markdown/__tests__/harness'
import { EStartupPhase, type StartupFrame } from '../startup-model'
import { WORDMARK_CELLS, WORDMARK_ROWS } from '../wordmark'

const WIDTH = 100

const HEIGHT = 24

const CWD = '/Users/dennis/Developer/atlas'

const HOME = '/Users/dennis'

const STATUS = 'wiring the harness'

const BENEATH = 'THE WORKSPACE UNDERNEATH'

const HALF_CELL = '▀'

const frame = (over: Partial<StartupFrame> = {}): StartupFrame => ({
  phase: EStartupPhase.Holding,
  reveal: 1,
  drain: 0,
  lift: 0,
  ...over,
})

async function paint(args: {
  frame: StartupFrame
  width?: number
  height?: number
}): Promise<string> {
  const width = args.width ?? WIDTH
  const height = args.height ?? HEIGHT

  const setup = await testRender(
    <box flexDirection="column" width={width} height={height}>
      {Array.from({ length: height }, (_, row) => (
        <text key={row}>{BENEATH}</text>
      ))}
      <Startup
        frame={args.frame}
        width={width}
        height={height}
        status={STATUS}
        cwd={CWD}
        home={HOME}
      />
    </box>,
    { width, height },
  )

  try {
    await setup.flush()
    return setup.captureCharFrame()
  } finally {
    await teardown(setup)
  }
}

const inkedCells = (painted: string): number => painted.split(HALF_CELL).length - 1

describe('the startup curtain', () => {
  it('hides the workspace it is drawn over', async () => {
    expect(await paint({ frame: frame() })).not.toContain(BENEATH)
  })

  it('says where it is and what it is doing', async () => {
    const painted = await paint({ frame: frame() })
    expect(painted).toContain('~/Developer/atlas')
    expect(painted).toContain(STATUS)
  })

  it('lays the mark down left to right', async () => {
    const early = inkedCells(await paint({ frame: frame({ reveal: 0.25 }) }))
    const half = inkedCells(await paint({ frame: frame({ reveal: 0.5 }) }))
    const whole = inkedCells(await paint({ frame: frame({ reveal: 1 }) }))

    expect(early).toBeLessThan(half)
    expect(half).toBeLessThan(whole)
  })

  it('starts on an empty ground rather than a mark that pops in', async () => {
    expect(inkedCells(await paint({ frame: frame({ reveal: 0 }) }))).toBe(0)
  })

  it('drains the mark away without moving it', async () => {
    const painted = await paint({ frame: frame({ drain: 1 }) })
    expect(inkedCells(painted)).toBe(0)
    expect(painted).not.toContain(BENEATH)
  })

  it('gives the workspace back row by row as it retracts', async () => {
    const rowsOf = (painted: string): number =>
      painted.split('\n').filter((row) => row.includes(BENEATH)).length

    expect(rowsOf(await paint({ frame: frame({ lift: 0 }) }))).toBe(0)
    expect(rowsOf(await paint({ frame: frame({ lift: 0.5 }) }))).toBeGreaterThan(0)
    expect(rowsOf(await paint({ frame: frame({ lift: 0.5 }) }))).toBeLessThan(HEIGHT)
  })

  it('trails a seam behind the retracting edge, and only while it retracts', async () => {
    const seamRow = (painted: string): number =>
      painted.split('\n').findIndex((row) => row.startsWith(HALF_CELL.repeat(WIDTH)))

    expect(seamRow(await paint({ frame: frame({ lift: 0 }) }))).toBe(-1)
    expect(seamRow(await paint({ frame: frame({ lift: 0.5 }) }))).toBeGreaterThan(0)
  })

  it('is nothing at all once it has fully retracted', async () => {
    const painted = await paint({ frame: frame({ lift: 1 }) })
    expect(painted).toContain(BENEATH)
    expect(painted).not.toContain(STATUS)
  })

  it('falls back to a one-line mark in a terminal too narrow to carry the wordmark', async () => {
    const painted = await paint({ frame: frame(), width: WORDMARK_CELLS - 10 })
    expect(painted).toContain('atlas')
    expect(painted).not.toContain(BENEATH)
  })

  it('falls back to it in a terminal too short for one too, rather than clipping the mark', async () => {
    const painted = await paint({ frame: frame(), height: WORDMARK_ROWS + 1 })
    expect(painted).toContain('atlas')
    expect(painted).not.toContain(HALF_CELL)
    expect(painted).not.toContain(BENEATH)
  })
})
