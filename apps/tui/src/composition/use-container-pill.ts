import { useMemo, useSyncExternalStore } from 'react'

import { containerPillOf, type SidebarContainer } from '../store/sidebar-model'
import type { AtlasApp } from './compose'

export function useContainerPill(args: { app: AtlasApp }): SidebarContainer | null {
  const { app } = args

  const location = useSyncExternalStore(
    app.executionLocation.subscribe,
    app.executionLocation.current,
  )
  const container = useSyncExternalStore(app.containerStatus.subscribe, app.containerStatus.current)

  return useMemo(() => containerPillOf({ location, container }), [location, container])
}
