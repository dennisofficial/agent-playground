import { describe, expect, it } from 'bun:test'
import React from 'react'

import { Shortcuts } from '../components/shortcuts'
import { cellsOf } from '../hint-layout'
import { keyColumnCells, type ShortcutGroup } from '../shortcuts'
import { frameOf } from './transcript-fixture'

const WIDTHS = [40, 60, 100, 200] as const

const GROUPS: readonly ShortcutGroup[] = [
  {
    title: 'Composer',
    shortcuts: [
      { key: '⏎', label: 'send — or open the newest block when the draft is empty' },
      { key: '⇧⏎', label: 'newline' },
    ],
  },
  { title: 'Session', shortcuts: [{ key: 'ctrl+n', label: 'new conversation' }] },
]

const WIDEST_KEY = GROUPS.flatMap((group) => group.shortcuts).reduce(
  (cells, shortcut) => Math.max(cells, cellsOf(shortcut.key)),
  0,
)

describe('keyColumnCells', () => {
  it('leaves the widest key clear of every label', () => {
    expect(keyColumnCells(GROUPS)).toBeGreaterThan(WIDEST_KEY)
  })

  it('answers for an empty list without reserving a column', () => {
    expect(keyColumnCells([])).toBeGreaterThan(0)
  })
})

describe('the shortcuts panel', () => {
  it('names every group, key and label', async () => {
    const frame = await frameOf(<Shortcuts width={100} groups={GROUPS} />, 100)
    for (const group of GROUPS) {
      expect(frame).toContain(group.title.toUpperCase())
      for (const shortcut of group.shortcuts) {
        expect(frame).toContain(shortcut.key)
        expect(frame).toContain(shortcut.label)
      }
    }
  })

  it('says how to close itself', async () => {
    const frame = await frameOf(<Shortcuts width={100} groups={GROUPS} />, 100)
    expect(frame).toContain('esc close')
  })

  it('never runs a row past the terminal', async () => {
    for (const width of WIDTHS) {
      const frame = await frameOf(<Shortcuts width={width} groups={GROUPS} />, width)
      for (const row of frame.split('\n')) expect(cellsOf(row.trimEnd())).toBeLessThanOrEqual(width)
    }
  })

  it('clips a label that will not fit rather than wrapping the row', async () => {
    const frame = await frameOf(<Shortcuts width={40} groups={GROUPS} />, 40)
    expect(frame).toContain('…')
  })
})
