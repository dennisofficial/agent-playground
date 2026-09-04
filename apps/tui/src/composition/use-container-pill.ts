import { useMemo, useSyncExternalStore } from 'react'

import { containerPillOf, type SidebarContainer } from '../store/sidebar-model'
import type { AtlasApp } from './compose'

/**
 * Two cells, one derivation: the thread's column decides whether the pill exists, the sandbox's
 * own status decides what it says. Both are held snapshots, so a quiet container costs no renders.
 */
export function useContainerPill(args: { app: AtlasApp }): SidebarContainer | null {
  const { app } = args

  const location = useSyncExternalStore(
    app.executionLocation.subscribe,
    app.executionLocation.current,
  )
  const container = useSyncExternalStore(app.containerStatus.subscribe, app.containerStatus.current)

  return useMemo(() => containerPillOf({ location, container }), [location, container])
}
