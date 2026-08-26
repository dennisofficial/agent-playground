import { describe, expect, it } from 'bun:test'
import React from 'react'

import { Shortcuts } from '../components/shortcuts'
import { cellsOf } from '../hint-layout'
import { keyColumnCells, SHORTCUT_GROUPS } from '../shortcuts'
import { frameOf } from './transcript-fixture'

const WIDTHS = [40, 60, 100, 200] as const

const WIDEST_KEY = SHORTCUT_GROUPS.flatMap((group) => group.shortcuts).reduce(
  (cells, shortcut) => Math.max(cells, cellsOf(shortcut.key)),
  0,
)

describe('keyColumnCells', () => {
  it('leaves the widest key clear of every label', () => {
    expect(keyColumnCells(SHORTCUT_GROUPS)).toBeGreaterThan(WIDEST_KEY)
  })

  it('answers for an empty list without reserving a column', () => {
    expect(keyColumnCells([])).toBeGreaterThan(0)
  })
})

describe('the shortcuts panel', () => {
  it('names every group, key and label', async () => {
    const frame = await frameOf(<Shortcuts width={100} />, 100)
    for (const group of SHORTCUT_GROUPS) {
      expect(frame).toContain(group.title.toUpperCase())
      for (const shortcut of group.shortcuts) {
        expect(frame).toContain(shortcut.key)
        expect(frame).toContain(shortcut.label)
      }
    }
  })

  it('says how to close itself', async () => {
    const frame = await frameOf(<Shortcuts width={100} />, 100)
    expect(frame).toContain('esc close')
  })

  it('never runs a row past the terminal', async () => {
    for (const width of WIDTHS) {
      const frame = await frameOf(<Shortcuts width={width} />, width)
      for (const row of frame.split('\n')) expect(cellsOf(row.trimEnd())).toBeLessThanOrEqual(width)
    }
  })

  it('clips a label that will not fit rather than wrapping the row', async () => {
    const frame = await frameOf(<Shortcuts width={40} />, 40)
    expect(frame).toContain('…')
  })
})
