import { describe, expect, it } from 'bun:test'

import { EKilledBy, EServiceStatus } from '@dltech/atlas-core'
import type { ServiceSnapshot } from '@dltech/atlas-harness'

import { foldServices } from '../service-fold'

const service = (over: Partial<ServiceSnapshot> = {}): ServiceSnapshot => ({
  serviceId: 'svc_1',
  command: 'bun run dev',
  description: 'web dev server',
  status: EServiceStatus.Running,
  pid: 4_242,
  logPath: '/tmp/atlas/services/svc_1.log',
  startedAt: '2026-08-27T12:00:00.000Z',
  ...over,
})

const settled = (serviceId: string, over: Partial<ServiceSnapshot> = {}): ServiceSnapshot =>
  service({
    serviceId,
    status: EServiceStatus.Exited,
    exitCode: 0,
    endedAt: '2026-08-27T12:01:00.000Z',
    ...over,
  })

describe('folding services for the sidebar', () => {
  it('shows everything when the settled ones fit under the cap', () => {
    const fold = foldServices({
      services: [service(), settled('svc_2'), settled('svc_3')],
      cap: 3,
    })

    expect(fold.shown.map((one) => one.serviceId)).toEqual(['svc_1', 'svc_2', 'svc_3'])
    expect(fold.hidden).toBe(0)
  })

  it('never folds a running service, however many settled ones crowd it', () => {
    const fold = foldServices({
      services: [settled('svc_1'), settled('svc_2'), settled('svc_3'), settled('svc_4'), service({ serviceId: 'svc_5' })],
      cap: 3,
    })

    expect(fold.shown.at(-1)?.serviceId).toBe('svc_5')
  })

  it('folds the oldest settled services first, keeping the most recent endings visible', () => {
    const fold = foldServices({
      services: [settled('svc_1'), settled('svc_2'), settled('svc_3'), settled('svc_4')],
      cap: 2,
    })

    expect(fold.shown.map((one) => one.serviceId)).toEqual(['svc_3', 'svc_4'])
    expect(fold.hidden).toBe(2)
  })

  it('flags the fold when a hidden service died on its own', () => {
    const fold = foldServices({
      services: [settled('svc_1', { exitCode: 1 }), settled('svc_2')],
      cap: 1,
    })

    expect(fold.hidden).toBe(1)
    expect(fold.hiddenFailed).toBe(true)
  })

  it('does not flag a hidden service the operator stopped', () => {
    const fold = foldServices({
      services: [
        settled('svc_1', {
          status: EServiceStatus.Killed,
          killedBy: EKilledBy.User,
          exitCode: undefined,
        }),
        settled('svc_2'),
      ],
      cap: 1,
    })

    expect(fold.hidden).toBe(1)
    expect(fold.hiddenFailed).toBe(false)
  })

  it('falls back to the crew cap when none is asked for', () => {
    const fold = foldServices({
      services: [settled('svc_1'), settled('svc_2'), settled('svc_3'), settled('svc_4')],
    })

    expect(fold.shown).toHaveLength(3)
    expect(fold.hidden).toBe(1)
  })
})
