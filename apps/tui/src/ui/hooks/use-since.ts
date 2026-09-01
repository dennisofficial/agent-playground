import { useEffect, useState } from 'react'

/**
 * When a condition last became true, held for as long as it stays true. A timer over this counts
 * the wait itself rather than whatever the wait is on, and does not restart when the thing being
 * waited for changes shape underneath it.
 */
export function useSince(active: boolean): number | null {
  const [since, setSince] = useState<number | null>(() => (active ? Date.now() : null))

  useEffect(() => {
    setSince((held) => (active ? (held ?? Date.now()) : null))
  }, [active])

  return active ? since : null
}
