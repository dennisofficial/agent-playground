import type { KeyEvent } from '@opentui/core'
import { useCallback, useMemo, useState, useEffect } from 'react'

import { EKilledBy, logTail, type ServiceSnapshot } from '@dltech/atlas-harness'
import { EPerfCounter, measurePerf } from '@dltech/atlas-core'

import { foldServices } from '../store/service-fold'
import type { SidebarCrewFold } from '../store/subagent-row'
import { useOutputScroll, type OutputScroll } from '../ui/hooks/use-output-scroll'
import {
  isServiceAlive,
  isServiceRunning,
  moveServiceSelection,
  openServices,
  selectedService,
  selectService,
  type ServicesState,
} from '../ui/services-model'
import { outputScrollCommand } from '../ui/shells-model'
import { useTickingNow } from './use-ticking-now'
import type { AtlasApp } from './compose'

const POLL_MS = 500

const PEEKED_CHARACTERS = 64_000

const STOP_KEYS = new Set(['k', 'x'])

export type ServicesControl = {
  services: readonly ServiceSnapshot[]
  folded: readonly ServiceSnapshot[]
  fold: SidebarCrewFold
  everywhere: readonly ServiceSnapshot[]
  running: number
  now: number
  state: ServicesState | null
  selected: ServiceSnapshot | undefined
  log: string
  scroll: OutputScroll
  handleOpen: (serviceId?: string) => void
  handleDismiss: () => void
  handleSelect: (serviceId: string) => void
  handleStop: (serviceId: string) => void
  handleKey: (key: KeyEvent) => void
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
  const [state, setState] = useState<ServicesState | null>(null)

  useEffect(() => {
    const poll = (): void =>
      measurePerf({
        key: EPerfCounter.PollServicesMs,
        run: () =>
          setServices((current) => {
            const latest = read()
            return sameServices(current, latest) ? current : latest
          }),
      })

    poll()
    const timer = setInterval(poll, POLL_MS)
    return () => clearInterval(timer)
  }, [read])

  const now = useTickingNow(services.some(isServiceRunning))

  const folded = useMemo(() => foldServices({ services }), [services])

  const selected = state === null ? undefined : selectedService({ state, services })

  const [log, setLog] = useState('')
  const openPath = selected?.logPath
  const scroll = useOutputScroll({ resetKey: selected?.serviceId })

  /**
   * The log is a file that grows without announcing itself, so the open drawer re-reads its tail
   * on the same cadence the roster polls on. A closed drawer holds no reader at all.
   */
  useEffect(() => {
    if (openPath === undefined) {
      setLog('')
      return
    }

    const peek = (): void => setLog(logTail({ path: openPath, characters: PEEKED_CHARACTERS }))
    peek()
    const timer = setInterval(peek, POLL_MS)
    return () => clearInterval(timer)
  }, [openPath])

  const handleOpen = useCallback(
    (serviceId?: string) =>
      setState(openServices({ services, ...(serviceId === undefined ? {} : { serviceId }) })),
    [services],
  )

  const handleDismiss = useCallback(() => setState(null), [])

  const handleSelect = useCallback(
    (serviceId: string) => setState(selectService({ services, serviceId })),
    [services],
  )

  const handleStop = useCallback(
    (serviceId: string) => {
      app.services.stop({ serviceId, by: EKilledBy.User })
      setState((current) => (current === null ? null : { ...current }))
    },
    [app],
  )

  const handleKey = useCallback(
    (key: KeyEvent) => {
      if (state === null) return

      if (key.name === 'escape' || key.name === 'q') {
        handleDismiss()
        return
      }

      const scrolling = outputScrollCommand(key)
      if (scrolling !== null) {
        scroll.handleCommand(scrolling)
        return
      }

      if (key.name === 'up' || key.name === 'down') {
        setState(
          moveServiceSelection({
            state,
            count: services.length,
            delta: key.name === 'up' ? -1 : 1,
          }),
        )
        return
      }

      const pressed = key.sequence?.toLowerCase() ?? ''
      if (STOP_KEYS.has(pressed) && selected !== undefined) handleStop(selected.serviceId)
    },
    [handleDismiss, handleStop, scroll, selected, services.length, state],
  )

  return useMemo(
    () => ({
      services,
      folded: folded.shown,
      fold: { hidden: folded.hidden, hiddenFailed: folded.hiddenFailed },
      everywhere: services,
      running: services.filter(isServiceAlive).length,
      now,
      state,
      selected,
      log,
      scroll,
      handleOpen,
      handleDismiss,
      handleSelect,
      handleStop,
      handleKey,
    }),
    [
      folded,
      handleDismiss,
      handleKey,
      handleOpen,
      handleSelect,
      handleStop,
      log,
      now,
      scroll,
      selected,
      services,
      state,
    ],
  )
}
