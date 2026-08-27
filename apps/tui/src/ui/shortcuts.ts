import { cellsOf } from './hint-layout'

export type Shortcut = { key: string; label: string }

export type ShortcutGroup = { title: string; shortcuts: readonly Shortcut[] }

export const SHORTCUT_KEY_GAP = 2

export function keyColumnCells(groups: readonly ShortcutGroup[]): number {
  const widest = groups.flatMap((group) => group.shortcuts).reduce(
    (cells, shortcut) => Math.max(cells, cellsOf(shortcut.key)),
    0,
  )
  return widest + SHORTCUT_KEY_GAP
}
