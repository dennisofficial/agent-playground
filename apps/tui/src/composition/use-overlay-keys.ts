import type { KeyEvent } from '@opentui/core'
import { useCallback } from 'react'

import { pressHandled, type PlacedBinding } from '../ui/keys'

export type OverlayKeyOwner = {
  open: boolean
  handleKey: (key: KeyEvent) => void
  /** Whether an unhandled key should still fall through to the global bindings. */
  porous?: boolean
}

/**
 * One overlay owns the keyboard at a time, and the order here is the order they stack. The veil is
 * not an owner: any key dismisses it, and only the keys that mean "dismiss" are swallowed rather
 * than also doing what they normally do.
 */
export function useOverlayKeys(args: {
  veil: { shown: boolean; dismiss: () => void; keys: readonly string[] }
  owners: readonly OverlayKeyOwner[]
  bindings: () => readonly PlacedBinding[]
}): (key: KeyEvent) => void {
  const { veil, owners, bindings } = args

  return useCallback(
    (key: KeyEvent) => {
      if (key.eventType === 'release') return

      if (veil.shown) {
        veil.dismiss()
        if (key.name === 'escape' || veil.keys.includes(key.sequence ?? '')) {
          key.preventDefault()
          return
        }
      }

      for (const owner of owners) {
        if (!owner.open) continue

        if (owner.porous !== true) key.preventDefault()
        owner.handleKey(key)
        return
      }

      if (pressHandled({ press: key, bindings: bindings() })) key.preventDefault()
    },
    [bindings, owners, veil],
  )
}
