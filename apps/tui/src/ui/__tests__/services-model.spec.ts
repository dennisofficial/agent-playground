import { EServiceStatus } from '@dltech/atlas-core'
import type { ServiceSnapshot } from '@dltech/atlas-harness'
import { describe, expect, it } from 'bun:test'

import {
  moveServiceSelection,
  openServices,
  selectedService,
  selectService,
} from '../services-model'

const service = (over: {
  serviceId: string
  status?: EServiceStatus
}): ServiceSnapshot => ({
  serviceId: over.serviceId,
  command: 'bun run dev',
  description: 'bun run dev',
  status: over.status ?? EServiceStatus.Exited,
  pid: 4242,
  logPath: '/tmp/svc.log',
  startedAt: '2026-08-27T12:00:00.000Z',
  endedAt: '2026-08-27T12:01:00.000Z',
})

describe('openServices', () => {
  it('lands on the service it was asked for', () => {
    const services = [service({ serviceId: 'svc_1' }), service({ serviceId: 'svc_2' })]

    expect(openServices({ services, serviceId: 'svc_2' })).toEqual({ index: 1 })
  })

  it('prefers the running one when it was not asked for any', () => {
    const services = [
      service({ serviceId: 'svc_1' }),
      service({ serviceId: 'svc_2', status: EServiceStatus.Running }),
    ]

    expect(openServices({ services })).toEqual({ index: 1 })
  })

  it('falls back to the first when none is running', () => {
    const services = [service({ serviceId: 'svc_1' }), service({ serviceId: 'svc_2' })]

    expect(openServices({ services })).toEqual({ index: 0 })
  })
})

describe('moveServiceSelection', () => {
  it('clamps at both ends', () => {
    expect(moveServiceSelection({ state: { index: 0 }, count: 2, delta: -1 })).toEqual({ index: 0 })
    expect(moveServiceSelection({ state: { index: 1 }, count: 2, delta: 1 })).toEqual({ index: 1 })
    expect(moveServiceSelection({ state: { index: 0 }, count: 2, delta: 1 })).toEqual({ index: 1 })
  })
})

describe('selectService', () => {
  it('points at the named service and at the first for one it does not know', () => {
    const services = [service({ serviceId: 'svc_1' }), service({ serviceId: 'svc_2' })]

    expect(selectService({ services, serviceId: 'svc_2' })).toEqual({ index: 1 })
    expect(selectService({ services, serviceId: 'svc_9' })).toEqual({ index: 0 })
  })
})

describe('selectedService', () => {
  it('keeps pointing at a service when the roster shrinks under the index', () => {
    const services = [service({ serviceId: 'svc_1' })]

    expect(selectedService({ state: { index: 4 }, services })?.serviceId).toBe('svc_1')
    expect(selectedService({ state: { index: 0 }, services: [] })).toBeUndefined()
  })
})
