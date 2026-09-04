import { EKilledBy, EServiceStatus, mayStillBeAlive } from '@dltech/atlas-core'
import type { ServiceSnapshot } from '@dltech/atlas-harness'

import { formatElapsed } from './theme'

export type ServicesState = { index: number }

export const isServiceRunning = (service: { status: EServiceStatus }): boolean =>
  service.status === EServiceStatus.Running

export function openServices(args: {
  services: readonly ServiceSnapshot[]
  serviceId?: string
}): ServicesState {
  const asked = args.services.findIndex((service) => service.serviceId === args.serviceId)
  if (asked >= 0) return { index: asked }

  const running = args.services.findIndex(isServiceRunning)
  return { index: running >= 0 ? running : 0 }
}

export function moveServiceSelection(args: {
  state: ServicesState
  count: number
  delta: number
}): ServicesState {
  if (args.count <= 0) return { index: 0 }

  const moved = args.state.index + Math.trunc(args.delta)
  return { index: Math.min(Math.max(moved, 0), args.count - 1) }
}

export function selectService(args: {
  services: readonly ServiceSnapshot[]
  serviceId: string
}): ServicesState {
  const found = args.services.findIndex((service) => service.serviceId === args.serviceId)
  return { index: found < 0 ? 0 : found }
}

export function selectedService(args: {
  state: ServicesState
  services: readonly ServiceSnapshot[]
}): ServiceSnapshot | undefined {
  return args.services[Math.min(Math.max(args.state.index, 0), args.services.length - 1)]
}

export const isServiceAlive = (service: {
  status: EServiceStatus
  exitCode?: number | undefined
}): boolean => mayStillBeAlive(service)

export function serviceNameLabel(service: { command: string; description: string }): string {
  const named = service.description.trim()
  return named === '' ? service.command.replace(/\s+/g, ' ').trim() : named
}

export function serviceStateLabel(service: ServiceSnapshot): string {
  if (service.status === EServiceStatus.Running) return 'running'
  if (service.status === EServiceStatus.Killed) {
    if (service.killedBy === EKilledBy.User) return 'stopped by you'
    if (service.killedBy === EKilledBy.Model) return 'stopped by atlas'
    if (service.killedBy === EKilledBy.SessionEnd) return 'stopped at session end'
    return 'stopped'
  }
  if (service.exitCode === undefined || service.exitCode === 0) return 'exited'
  return `exit ${service.exitCode}`
}

const instantOf = (iso: string): number | null => {
  const at = Date.parse(iso)
  return Number.isNaN(at) ? null : at
}

const settledAt = (service: ServiceSnapshot): number | null => {
  if (isServiceRunning(service)) return null
  return service.endedAt === undefined ? null : instantOf(service.endedAt)
}

export function serviceElapsedMs(args: { service: ServiceSnapshot; now: number }): number | null {
  const started = instantOf(args.service.startedAt)
  if (started === null) return null

  return Math.max(0, (settledAt(args.service) ?? args.now) - started)
}

const READOUT_SEPARATOR = ' · '

export function serviceReadout(args: { service: ServiceSnapshot; now: number }): string {
  const state = serviceStateLabel(args.service)
  const elapsed = serviceElapsedMs(args)
  return elapsed === null ? state : `${state}${READOUT_SEPARATOR}${formatElapsed(elapsed)}`
}
