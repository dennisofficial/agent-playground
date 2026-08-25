import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { BranchId, ClockPort, EventId, IdPort, RunId } from '@dltech/atlas-core'
import { toBranchId, toCallId, toEventId, toRunId } from '@dltech/atlas-core'

import { openAtlasDatabase, type AtlasDatabase } from '../database'
import { PrismaBranchStore } from '../branch-store'
import { PrismaEventLog } from '../event-log'

export type StoreFixture = {
  databaseUrl: string
  log: PrismaEventLog
  branches: PrismaBranchStore
  clock: SteppingClock
  reopen: () => Promise<StoreFixture>
  close: () => Promise<void>
}

export class SteppingClock implements ClockPort {
  private ticks = 0

  now(): string {
    this.ticks += 1
    return new Date(Date.UTC(2026, 0, 1) + this.ticks * 1000).toISOString()
  }
}

export class CountingIds implements IdPort {
  constructor(private readonly prefix: string) {}

  private counters = new Map<string, number>()

  private next(kind: string): string {
    const seen = (this.counters.get(kind) ?? 0) + 1
    this.counters.set(kind, seen)
    return `${this.prefix}-${kind}-${seen}`
  }

  nextBranchId(): BranchId {
    return toBranchId(this.next('branch'))
  }

  nextRunId(): RunId {
    return toRunId(this.next('run'))
  }

  nextEventId(): EventId {
    return toEventId(this.next('event'))
  }

  nextCallId() {
    return toCallId(this.next('call'))
  }
}

export function createTempDatabaseUrl(): { databaseUrl: string; discard: () => void } {
  const directory = mkdtempSync(join(tmpdir(), 'atlas-store-'))
  return {
    databaseUrl: `file:${join(directory, 'atlas.db')}`,
    discard: () => rmSync(directory, { recursive: true, force: true }),
  }
}

async function attach({
  databaseUrl,
  discard,
  idPrefix,
}: {
  databaseUrl: string
  discard: () => void
  idPrefix: string
}): Promise<StoreFixture> {
  const database: AtlasDatabase = await openAtlasDatabase({ databaseUrl })
  const clock = new SteppingClock()
  const ids = new CountingIds(idPrefix)
  const deps = { prisma: database.prisma, clock, ids }

  return {
    databaseUrl,
    clock,
    log: new PrismaEventLog(deps),
    branches: new PrismaBranchStore(deps),
    reopen: async () => {
      await database.close()
      return attach({ databaseUrl, discard, idPrefix: `${idPrefix}b` })
    },
    close: async () => {
      await database.close()
      discard()
    },
  }
}

export async function openStoreFixture(): Promise<StoreFixture> {
  const { databaseUrl, discard } = createTempDatabaseUrl()
  return attach({ databaseUrl, discard, idPrefix: 'a' })
}

export async function openSecondWriter(fixture: StoreFixture): Promise<{
  log: PrismaEventLog
  close: () => Promise<void>
}> {
  const database = await openAtlasDatabase({ databaseUrl: fixture.databaseUrl })
  const log = new PrismaEventLog({
    prisma: database.prisma,
    clock: new SteppingClock(),
    ids: new CountingIds('w2'),
  })
  return { log, close: () => database.close() }
}
