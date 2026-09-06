import { useMemo, useSyncExternalStore } from 'react'

import type { FooterItem } from '../ui/footer-item'
import { locationPillOf } from '../ui/location-pill'
import type { AtlasApp } from './compose'

export function useLocationPill(args: { app: AtlasApp }): FooterItem | null {
  const location = useSyncExternalStore(
    args.app.executionLocation.subscribe,
    args.app.executionLocation.current,
  )

  return useMemo(() => locationPillOf({ location }), [location])
}
