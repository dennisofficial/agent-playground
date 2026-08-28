import { ECommandGroup, ECommandKind, type CommandSpec } from '@dltech/atlas-core'
import { describe, expect, it } from 'bun:test'
import React from 'react'

import { openCommandMenu, type CommandMenuState } from '../command-menu-model'
import { CommandMenu, KIND_MARK } from '../components/command-menu'
import { cellsOf } from '../hint-layout'
import { glyph } from '../theme'
import { frameOf } from './transcript-fixture'

const WIDTH = 80

const SPECS: readonly CommandSpec[] = [
  {
    name: 'compact',
    kind: ECommandKind.Local,
    summary: 'replace the history so far with a summary',
    group: ECommandGroup.Context,
    argumentHint: '[all]',
  },
  {
    name: 'clear',
    kind: ECommandKind.Local,
    summary: 'start a fresh conversation',
    group: ECommandGroup.Session,
  },
  {
    name: 'review',
    kind: ECommandKind.Skill,
    summary: 'review the working tree against the spec',
    group: ECommandGroup.Workspace,
  },
]

const stateOf = (text: string): CommandMenuState => {
  const state = openCommandMenu({ text, specs: SPECS })
  if (state === null) throw new Error(`expected the menu to open for ${JSON.stringify(text)}`)
  return state
}

describe('the command menu', () => {
  it('names every match with its summary', async () => {
    const frame = await frameOf(<CommandMenu state={stateOf('/')} width={WIDTH} />, WIDTH)

    for (const spec of SPECS) {
      expect(frame).toContain(`/${spec.name}`)
      expect(frame).toContain(spec.summary)
    }
  })

  it('shows the argument hint a command declares', async () => {
    const frame = await frameOf(<CommandMenu state={stateOf('/')} width={WIDTH} />, WIDTH)

    expect(frame).toContain('[all]')
  })

  it('marks the selected row', async () => {
    const frame = await frameOf(<CommandMenu state={stateOf('/')} width={WIDTH} />, WIDTH)
    const selected = frame.split('\n').filter((row) => row.includes(glyph.selected))

    expect(selected).toHaveLength(1)
    expect(selected[0]).toContain('/compact')
  })

  it('tells a skill apart from a local command', async () => {
    const frame = await frameOf(<CommandMenu state={stateOf('/')} width={WIDTH} />, WIDTH)

    expect(frame).toContain(KIND_MARK[ECommandKind.Skill])
    expect(frame).toContain(KIND_MARK[ECommandKind.Local])
  })

  it('says how to complete the selection', async () => {
    const frame = await frameOf(<CommandMenu state={stateOf('/')} width={WIDTH} />, WIDTH)

    expect(frame).toContain('complete')
    expect(frame).toContain('1/3')
  })

  it('never runs a row past the terminal', async () => {
    for (const width of [40, 60, 80, 120]) {
      const frame = await frameOf(<CommandMenu state={stateOf('/')} width={width} />, width)
      for (const row of frame.split('\n')) expect(cellsOf(row.trimEnd())).toBeLessThanOrEqual(width)
    }
  })
})
