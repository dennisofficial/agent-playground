import { useCallback, useMemo, useState, useEffect } from 'react'

import type { ServiceSnapshot } from '@dltech/atlas-harness'

import { foldServices } from '../store/service-fold'
import type { SidebarCrewFold } from '../store/subagent-row'
import { isServiceAlive, isServiceRunning } from '../ui/services-model'
import { useTickingNow } from './use-ticking-now'
import type { AtlasApp } from './compose'

const POLL_MS = 500

export type ServicesControl = {
  services: readonly ServiceSnapshot[]
  folded: readonly ServiceSnapshot[]
  fold: SidebarCrewFold
  everywhere: readonly ServiceSnapshot[]
  running: number
  now: number
}

const sameServices = (
  left: readonly ServiceSnapshot[],
  right: readonly ServiceSnapshot[],
): boolean => {
  if (left.length !== right.length) return false

  return left.every((service, index) => {
    const other = right[index]
    if (other === undefined) return false
    return (
      service.serviceId === other.serviceId &&
      service.status === other.status &&
      service.exitCode === other.exitCode
    )
  })
}

/**
 * A service is live process state rather than an event in the log, so nothing publishes a delta
 * when one exits or starts. Polling is the honest mechanism; the snapshot comparison is what keeps
 * it from re-rendering the tree twice a second while the roster sits idle.
 *
 * Unlike shells there is one list: services are session-global, so the sidebar and the exit guard
 * read the same poll.
 */
export function useServices({ app }: { app: AtlasApp }): ServicesControl {
  const read = useCallback((): readonly ServiceSnapshot[] => app.services.list(), [app])
  const [services, setServices] = useState<readonly ServiceSnapshot[]>(read)

  useEffect(() => {
    const poll = (): void =>
      setServices((current) => {
        const latest = read()
        return sameServices(current, latest) ? current : latest
      })

    poll()
    const timer = setInterval(poll, POLL_MS)
    return () => clearInterval(timer)
  }, [read])

  const now = useTickingNow(services.some(isServiceRunning))

  const folded = useMemo(() => foldServices({ services }), [services])

  return useMemo(
    () => ({
      services,
      folded: folded.shown,
      fold: { hidden: folded.hidden, hiddenFailed: folded.hiddenFailed },
      everywhere: services,
      running: services.filter(isServiceAlive).length,
      now,
    }),
    [folded, now, services],
  )
}
