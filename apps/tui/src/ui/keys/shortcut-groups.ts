import type { Shortcut, ShortcutGroup } from '../shortcuts'
import { describedBy, EKeyGroup, type PlacedBinding } from './binding'
import { spellChord } from './chord'

const GROUP_ORDER: readonly EKeyGroup[] = [EKeyGroup.Composer, EKeyGroup.Session, EKeyGroup.Turn]

export const NATIVE_SHORTCUTS: Readonly<Record<string, readonly Shortcut[]>> = {
  [EKeyGroup.Composer]: [{ key: '⇧⏎', label: 'newline' }],
}

const shortcutOf = (binding: PlacedBinding): Shortcut => ({
  key: spellChord(binding.chord),
  label: describedBy(binding),
})

export function groupsOfBindings(bindings: readonly PlacedBinding[]): readonly ShortcutGroup[] {
  return GROUP_ORDER.flatMap((title) => {
    const shortcuts = [
      ...bindings.filter((binding) => binding.group === title).map(shortcutOf),
      ...(NATIVE_SHORTCUTS[title] ?? []),
    ]
    return shortcuts.length === 0 ? [] : [{ title, shortcuts }]
  })
}
