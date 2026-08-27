import { afterAll, beforeAll, describe, expect, it } from 'bun:test'

import { ClockPort, CredentialPort, EventLogPort, IdPort, toBranchId } from '@dltech/atlas-core'

import { KeychainCredentialPort } from '../../credentials/keychain-credential-port'
import type { KeychainReader } from '../../credentials/keychain-reader'
import {
  BranchStorePort,
  PrismaBranchStore,
  PrismaEventLog,
  RandomIds,
  SystemClock,
  openAtlasDatabase,
  type AtlasDatabase,
} from '../../store'
import { createTempDatabaseUrl } from '../../store/__tests__/harness'
import { createHarnessContainer } from '../create-harness-container'
import { portToken, type DependencyContainer } from '../injection'
import { KeychainReaderToken, PrismaClientToken, WorkspaceRoot } from '../tokens'

const silentReader: KeychainReader = { readGenericPassword: async () => '{}' }

describe('createHarnessContainer', () => {
  let database: AtlasDatabase
  let discard: () => void
  let harness: DependencyContainer

  beforeAll(async () => {
    const temporary = createTempDatabaseUrl()
    discard = temporary.discard
    database = await openAtlasDatabase({ databaseUrl: temporary.databaseUrl })

    harness = createHarnessContainer()
    harness.register(PrismaClientToken, { useValue: database.prisma })
    harness.register(KeychainReaderToken, { useValue: silentReader })
  })

  afterAll(async () => {
    await database.close()
    discard()
  })

  it('resolves the clock port to the system clock', () => {
    expect(harness.resolve(portToken(ClockPort))).toBeInstanceOf(SystemClock)
  })

  it('resolves the id port to random ids', () => {
    expect(harness.resolve(portToken(IdPort))).toBeInstanceOf(RandomIds)
  })

  it('resolves the event log port to the prisma event log', () => {
    expect(harness.resolve(portToken(EventLogPort))).toBeInstanceOf(PrismaEventLog)
  })

  it('resolves the branch store port to the prisma branch store', () => {
    expect(harness.resolve(portToken(BranchStorePort))).toBeInstanceOf(PrismaBranchStore)
  })

  it('resolves the credential port to the keychain credential port', () => {
    expect(harness.resolve(portToken(CredentialPort))).toBeInstanceOf(KeychainCredentialPort)
  })

  it('injects the registered prisma client into the event log it builds', async () => {
    const log = harness.resolve(portToken(EventLogPort))
    expect(await log.head({ branchId: toBranchId('brn_absent') })).toBe(0)
  })

  it('injects the registered clock and ids into the branch store it builds', async () => {
    const branches = harness.resolve(portToken(BranchStorePort))
    const created = await branches.create({ title: 'resolved through the container' })
    expect(created.id).toStartWith('brn_')
    expect(created.head).toBe(0)
  })
})

describe('container isolation', () => {
  it('keeps value registrations out of an independently created container', () => {
    const first = createHarnessContainer()
    const second = createHarnessContainer()

    first.register(WorkspaceRoot, { useValue: '/tmp/first' })

    expect(first.isRegistered(WorkspaceRoot)).toBe(true)
    expect(second.isRegistered(WorkspaceRoot)).toBe(false)
  })

  it('keeps a port override out of an independently created container', () => {
    class FrozenClock implements ClockPort {
      now(): string {
        return '2026-01-01T00:00:00.000Z'
      }
    }

    const first = createHarnessContainer()
    const second = createHarnessContainer()

    first.register(portToken(ClockPort), { useClass: FrozenClock })

    expect(first.resolve(portToken(ClockPort))).toBeInstanceOf(FrozenClock)
    expect(second.resolve(portToken(ClockPort))).toBeInstanceOf(SystemClock)
  })

  it('gives each container its own instance of a resolved port', () => {
    const first = createHarnessContainer()
    const second = createHarnessContainer()

    expect(first.resolve(portToken(IdPort))).not.toBe(second.resolve(portToken(IdPort)))
  })
})
