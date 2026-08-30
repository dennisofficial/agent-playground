import { describe, expect, it } from 'bun:test'
import {
  AccountUsagePort,
  EUsageWindow,
  NO_USAGE,
  toAccountId,
  type AccountId,
  type AccountUsage,
} from '@dltech/atlas-core'

import { createAccountUsageService, USAGE_POLL_FLOOR_MS } from '../account-usage-service'

const ACCOUNT = toAccountId('account-1')

const usageAt = (utilization: number): AccountUsage => ({
  [EUsageWindow.FiveHour]: { utilization, resetsAt: null },
  [EUsageWindow.SevenDay]: null,
})

class CountingUsage extends AccountUsagePort {
  reads = 0
  answer: AccountUsage | null = usageAt(34)

  async read(args: { accountId: AccountId }): Promise<AccountUsage | null> {
    void args
    this.reads += 1
    return this.answer
  }
}

const serviceOf = (args: { port: CountingUsage; now: () => number }) =>
  createAccountUsageService({ usage: args.port, now: args.now })

describe('the account usage service', () => {
  it('reads nothing until it is asked to', () => {
    const port = new CountingUsage()
    const service = serviceOf({ port, now: () => 0 })

    expect(service.snapshot()).toEqual(NO_USAGE)
    expect(port.reads).toBe(0)
  })

  it('publishes what it read, and bumps its version so a subscriber re-renders', async () => {
    const port = new CountingUsage()
    const service = serviceOf({ port, now: () => 0 })
    let notifications = 0
    service.subscribe(() => {
      notifications += 1
    })

    await service.refresh({ accountId: ACCOUNT })

    expect(service.snapshotFor({ accountId: ACCOUNT })[EUsageWindow.FiveHour]?.utilization).toBe(34)
    expect(service.version()).toBe(1)
    expect(notifications).toBe(1)
  })

  it('keeps the account that answers apart from the accounts merely asked about', async () => {
    const port = new CountingUsage()
    const service = serviceOf({ port, now: () => 0 })

    await service.refresh()

    expect(service.snapshot()[EUsageWindow.FiveHour]?.utilization).toBe(34)
    expect(service.snapshotFor({ accountId: ACCOUNT })).toEqual(NO_USAGE)
  })

  it('reports a window it has never asked about as never polled', () => {
    const service = serviceOf({ port: new CountingUsage(), now: () => 0 })
    expect(service.snapshotFor({ accountId: ACCOUNT })).toEqual(NO_USAGE)
  })

  it('holds the floor rather than asking again on every keystroke', async () => {
    const port = new CountingUsage()
    let clock = 0
    const service = serviceOf({ port, now: () => clock })

    await service.refresh({ accountId: ACCOUNT })
    clock = USAGE_POLL_FLOOR_MS - 1
    await service.refresh({ accountId: ACCOUNT })

    expect(port.reads).toBe(1)

    clock = USAGE_POLL_FLOOR_MS
    await service.refresh({ accountId: ACCOUNT })

    expect(port.reads).toBe(2)
  })

  it('asks anyway when the caller says the reading matters now', async () => {
    const port = new CountingUsage()
    const service = serviceOf({ port, now: () => 0 })

    await service.refresh({ accountId: ACCOUNT })
    await service.refresh({ accountId: ACCOUNT, force: true })

    expect(port.reads).toBe(2)
  })

  it('holds the floor against a poll that is still in flight', async () => {
    const port = new CountingUsage()
    const service = serviceOf({ port, now: () => 0 })

    await Promise.all([
      service.refresh({ accountId: ACCOUNT }),
      service.refresh({ accountId: ACCOUNT }),
      service.refresh({ accountId: ACCOUNT }),
    ])

    expect(port.reads).toBe(1)
  })

  it('keeps the last good reading when a poll comes back empty', async () => {
    const port = new CountingUsage()
    let clock = 0
    const service = serviceOf({ port, now: () => clock })

    await service.refresh({ accountId: ACCOUNT })
    port.answer = null
    clock = USAGE_POLL_FLOOR_MS
    await service.refresh({ accountId: ACCOUNT })

    expect(service.snapshotFor({ accountId: ACCOUNT })[EUsageWindow.FiveHour]?.utilization).toBe(34)
    expect(service.version()).toBe(1)
  })

  it('holds each account to its own floor rather than one shared floor', async () => {
    const port = new CountingUsage()
    const service = serviceOf({ port, now: () => 0 })

    await service.refresh({ accountId: ACCOUNT })
    await service.refresh({ accountId: toAccountId('account-2') })
    await service.refresh({ accountId: ACCOUNT })

    expect(port.reads).toBe(2)
  })

  it('stops polling when it is torn down', async () => {
    const port = new CountingUsage()
    const service = serviceOf({ port, now: () => 0 })

    service.track({ accountId: ACCOUNT })
    service.dispose()
    await service.refresh({ accountId: ACCOUNT, force: true })

    expect(service.version()).toBe(0)
  })
})
