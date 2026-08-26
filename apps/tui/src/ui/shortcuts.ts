import { cellsOf } from './hint-layout'

export type Shortcut = { key: string; label: string }

export type ShortcutGroup = { title: string; shortcuts: readonly Shortcut[] }

export const SHORTCUT_GROUPS: readonly ShortcutGroup[] = [
  {
    title: 'Composer',
    shortcuts: [
      { key: '⏎', label: 'send — or open the newest block when the draft is empty' },
      { key: '⇧⏎', label: 'newline' },
      { key: '?', label: 'this list, on an empty draft' },
    ],
  },
  {
    title: 'Session',
    shortcuts: [
      { key: 'ctrl+n', label: 'new conversation' },
      { key: 'ctrl+p', label: 'model and effort' },
      { key: 'ctrl+b', label: 'sidebar' },
      { key: 'ctrl+o', label: 'settings' },
    ],
  },
  {
    title: 'Turn',
    shortcuts: [
      { key: 'esc', label: 'interrupt' },
      { key: 'ctrl+c', label: 'quit' },
    ],
  },
]

export const SHORTCUT_KEY_GAP = 2

export function keyColumnCells(groups: readonly ShortcutGroup[]): number {
  const widest = groups.flatMap((group) => group.shortcuts).reduce(
    (cells, shortcut) => Math.max(cells, cellsOf(shortcut.key)),
    0,
  )
  return widest + SHORTCUT_KEY_GAP
}
