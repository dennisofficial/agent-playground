import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react'

import type { BoundPort } from '@dltech/atlas-harness'

import { containerPillOf, exposedPortsOf, type SidebarContainer } from '../store/sidebar-model'
import type { AtlasApp } from './compose'

const samePorts = (left: readonly BoundPort[], right: readonly BoundPort[]): boolean =>
  left.length === right.length &&
  left.every(
    (one, at) =>
      one.containerPort === right[at]?.containerPort && one.hostPort === right[at]?.hostPort,
  )

function useExposedPorts(args: { shells: AtlasApp['shells'] }): readonly BoundPort[] {
  const read = useCallback(
    () => exposedPortsOf({ shells: args.shells.listEverywhere() }),
    [args.shells],
  )
  const [exposed, setExposed] = useState(read)

  useEffect(() => {
    const update = (): void =>
      setExposed((current) => {
        const latest = read()
        return samePorts(current, latest) ? current : latest
      })

    update()
    return args.shells.subscribe(update)
  }, [args.shells, read])

  return exposed
}

export function useContainerPill(args: { app: AtlasApp }): SidebarContainer | null {
  const { app } = args

  const location = useSyncExternalStore(
    app.executionLocation.subscribe,
    app.executionLocation.current,
  )
  const container = useSyncExternalStore(app.containerStatus.subscribe, app.containerStatus.current)
  const exposed = useExposedPorts({ shells: app.shells })

  return useMemo(
    () => containerPillOf({ location, container, exposed }),
    [location, container, exposed],
  )
}
