import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

import {
  getAppliedMigrations,
  PrismaBunSqlite,
  runMigrations,
  type Migration,
} from 'prisma-adapter-bun-sqlite'

import { PrismaClient } from '../../prisma/generated/client'
import { atlasMigrationsDirectory, loadAtlasMigrations } from './migrations'
import { atlasDatabaseUrl, databaseFileFromUrl } from './paths'
import { retryOnWriteConflict } from './retry'

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

export class DatabaseFromNewerAtlasError extends Error {
  readonly migrations: readonly string[]

  constructor(args: { file: string; migrations: readonly string[] }) {
    super(
      `The Atlas database at ${args.file} already holds migrations this build does not know: ${args.migrations.join(', ')}. ` +
        'It was written by a newer Atlas and is untouched — update Atlas rather than pointing this build at it.',
    )
    this.name = 'DatabaseFromNewerAtlasError'
    this.migrations = args.migrations
  }
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

  await applyMigrations(factory, file)

  const prisma = new PrismaClient({ adapter: factory })
  return {
    prisma,
    databaseUrl,
    close: async () => {
      await prisma.$disconnect()
    },
  }
}

// Two TUIs launched in the same instant both find a migration unapplied and both run its DDL, so
// each attempt is one transaction behind the retry loop: the loser fails with SQLITE_BUSY, rolls
// back cleanly, and retries into a world where the winner's run has already landed.
async function applyMigrations(factory: PrismaBunSqlite, file: string): Promise<void> {
  const migrations = await loadAtlasMigrations()
  if (migrations.length === 0) throw new Error(noMigrations())

  await retryOnWriteConflict({
    run: async () => {
      const adapter = await factory.connect()
      try {
        await refuseDatabaseFromANewerAtlas({ adapter, migrations, file })
        await runMigrations(adapter, migrations, { logger: () => undefined, useTransaction: true })
      } finally {
        await adapter.dispose()
      }
    },
  })
}

async function refuseDatabaseFromANewerAtlas(args: {
  adapter: Awaited<ReturnType<PrismaBunSqlite['connect']>>
  migrations: Migration[]
  file: string
}): Promise<void> {
  const known = new Set(args.migrations.map((migration) => migration.name))
  const applied = await getAppliedMigrations(args.adapter)
  const foreign = applied.filter((name) => !known.has(name))
  if (foreign.length === 0) return

  throw new DatabaseFromNewerAtlasError({ file: args.file, migrations: foreign })
}

/**
 * Applying nothing leaves a database with no tables, and every query then fails somewhere far from
 * the cause — so an empty migration set is a startup failure rather than a schemaless database.
 */
const noMigrations = (): string =>
  [
    'Atlas found no migrations to apply.',
    `A checkout reads them from ${atlasMigrationsDirectory()};`,
    'the compiled binary reads src/store/migrations.generated.ts, written by',
    'packages/harness/prisma/embed-migrations.ts during the build.',
  ].join(' ')
