import { EServiceStatus, serviceFailed } from '@dltech/atlas-core'
import type { ServiceSnapshot } from '@dltech/atlas-harness'

import { DEFAULT_CREW_CAP, type CrewFold } from './crew-fold'

/**
 * Services have no viewer and nothing to acknowledge, so the whole retirement policy collapses to
 * one rule: a running service always shows, a settled one shows while there is room, and the rest
 * fold away oldest-first. The registry lists in start order, so the tail of the settled list is
 * the part worth keeping.
 */
export function foldServices(args: {
  services: readonly ServiceSnapshot[]
  cap?: number
}): CrewFold<ServiceSnapshot> {
  const cap = args.cap ?? DEFAULT_CREW_CAP
  const settled = args.services.filter((service) => service.status !== EServiceStatus.Running)
  const spared = new Set(
    settled.slice(Math.max(0, settled.length - cap)).map((service) => service.serviceId),
  )

  const shown: ServiceSnapshot[] = []
  const hidden: ServiceSnapshot[] = []

  for (const service of args.services) {
    if (service.status === EServiceStatus.Running || spared.has(service.serviceId)) {
      shown.push(service)
      continue
    }

    hidden.push(service)
  }

  return {
    shown,
    hidden: hidden.length,
    hiddenFailed: hidden.some((service) => serviceFailed(service)),
  }
}
