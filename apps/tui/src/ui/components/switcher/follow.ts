import type { ScrollBoxRenderable } from '@opentui/core'
import { useRenderer } from '@opentui/react'
import { useEffect, useRef } from 'react'

import { refKey } from '@dltech/atlas-core'

import { useProportionalThumb } from '../../scrollbar-thumb'
import { cardAt, type SwitcherRow } from '../../switcher-model'

/**
 * OpenTUI lays a frame out after React has committed it, so on the commit that moved the highlight
 * the row it moved to still has no geometry — an effect reading it finds a zero-height viewport and
 * scrolls nowhere. The chase therefore waits for the renderer's next painted frame, and keeps
 * waiting while the viewport measures nothing, which is the state the drawer mounts in.
 */
export function useSelectionInView(args: {
  rows: readonly SwitcherRow[]
  index: number
}): (box: ScrollBoxRenderable | null) => void {
  const renderer = useRenderer()
  const scroller = useRef<ScrollBoxRenderable | null>(null)
  const attach = useProportionalThumb(scroller)
  const wanted = cardAt({ rows: args.rows, index: args.index })
  const key = wanted === undefined ? undefined : refKey(wanted.ref)

  useEffect(() => {
    if (key === undefined) return

    const chase = (): void => {
      const box = scroller.current
      if (box === null || box.viewport.height === 0) return

      box.scrollChildIntoView(key)
      renderer.off('frame', chase)
    }

    renderer.on('frame', chase)
    return () => void renderer.off('frame', chase)
  }, [args.index, args.rows.length, key, renderer])

  return attach
}
