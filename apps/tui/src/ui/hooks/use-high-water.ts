/**
 * A live block grows and never shrinks until it settles.
 *
 * The streaming window fills to its tail depth, empties when a call settles, and fills again for the
 * next one — and because the transcript is bottom-sticky, every one of those steps moves every line
 * above it. A reader trying to read a paragraph while a turn runs watches it walk up and down the
 * screen.
 *
 * So the height is a RATCHET: while the run is live it only ever grows, the space it has claimed
 * stays claimed, and the next call streams into padding that is already there. When the run settles
 * the mark is dropped and the final state is drawn once.
 */

import { useRef } from 'react'

export function useHighWater(args: { rows: number; live: boolean }): number {
  const mark = useRef(0)

  if (!args.live) {
    mark.current = 0
    return args.rows
  }

  if (args.rows > mark.current) mark.current = args.rows
  return mark.current
}
