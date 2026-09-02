import { describe, expect, it } from 'bun:test'
import { Database } from 'bun:sqlite'

import { DatabaseFromNewerAtlasError, openAtlasDatabase } from '../database'
import { databaseFileFromUrl } from '../paths'
import { createTempDatabaseUrl } from './harness'

const FUTURE_MIGRATION = '20270101000000_from_the_future'

describe('opening the database alongside another Atlas', () => {
  it('lets two launches in the same instant both reach a queryable schema', async () => {
    const { databaseUrl, discard } = createTempDatabaseUrl()
    try {
      const [first, second] = await Promise.all([
        openAtlasDatabase({ databaseUrl }),
        openAtlasDatabase({ databaseUrl }),
      ])

      expect(await first.prisma.thread.count()).toBe(0)
      expect(await second.prisma.thread.count()).toBe(0)
      await first.close()
      await second.close()
    } finally {
      discard()
    }
  })

  it('waits out a writer holding the database rather than crashing the launch', async () => {
    const { databaseUrl, discard } = createTempDatabaseUrl()
    try {
      const created = await openAtlasDatabase({ databaseUrl })
      await created.close()

      const holder = new Database(databaseFileFromUrl(databaseUrl))
      holder.run('BEGIN IMMEDIATE')
      const opening = openAtlasDatabase({ databaseUrl })

      await new Promise((resolve) => setTimeout(resolve, 400))
      holder.run('ROLLBACK')
      holder.close()

      const database = await opening
      expect(await database.prisma.thread.count()).toBe(0)
      await database.close()
    } finally {
      discard()
    }
  })
})

describe('a database written by a newer Atlas', () => {
  it('is refused by name rather than failing somewhere far from the cause', async () => {
    const { databaseUrl, discard } = createTempDatabaseUrl()
    try {
      const created = await openAtlasDatabase({ databaseUrl })
      await created.close()

      const direct = new Database(databaseFileFromUrl(databaseUrl))
      direct
        .prepare(
          `INSERT INTO _prisma_migrations (id, checksum, migration_name) VALUES ('x', 'x', '${FUTURE_MIGRATION}')`,
        )
        .run()
      direct.close()

      const failure = await openAtlasDatabase({ databaseUrl }).catch((error: unknown) => error)

      expect(failure).toBeInstanceOf(DatabaseFromNewerAtlasError)
      expect((failure as DatabaseFromNewerAtlasError).message).toContain(FUTURE_MIGRATION)
      expect((failure as DatabaseFromNewerAtlasError).message).toContain('update Atlas')
      expect((failure as DatabaseFromNewerAtlasError).message).not.toContain('move it aside')
    } finally {
      discard()
    }
  })
})
