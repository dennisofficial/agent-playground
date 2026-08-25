import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

import { PrismaBunSqlite, runMigrations } from 'prisma-adapter-bun-sqlite'

import { PrismaClient } from '../../prisma/generated/client'
import { loadAtlasMigrations } from './migrations'
import { atlasDatabaseUrl, databaseFileFromUrl } from './paths'

// `bun:sqlite` is synchronous, so SQLite's own `busy_timeout` blocks the thread rather than the
// promise. A second writer in the same process would therefore stall the writer it is waiting for,
// so the wait is kept short here and contention is resolved by retrying in JS instead.
// https://www.sqlite.org/c3ref/busy_timeout.html
const BUSY_TIMEOUT_MS = 250

export type AtlasDatabase = {
  prisma: PrismaClient
  databaseUrl: string
  close: () => Promise<void>
}

export async function openAtlasDatabase({
  databaseUrl = atlasDatabaseUrl(),
}: { databaseUrl?: string } = {}): Promise<AtlasDatabase> {
  const file = databaseFileFromUrl(databaseUrl)
  if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true })

  const factory = new PrismaBunSqlite({
    url: databaseUrl,
    wal: { enabled: true, busyTimeout: BUSY_TIMEOUT_MS },
  })

  await applyMigrations(factory)

  const prisma = new PrismaClient({ adapter: factory })
  return {
    prisma,
    databaseUrl,
    close: async () => {
      await prisma.$disconnect()
    },
  }
}

async function applyMigrations(factory: PrismaBunSqlite): Promise<void> {
  const adapter = await factory.connect()
  try {
    await runMigrations(adapter, await loadAtlasMigrations(), { logger: () => undefined })
  } finally {
    await adapter.dispose()
  }
}
