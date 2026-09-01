import { describe, expect, it } from 'bun:test'

import { readdirSync } from 'node:fs'

import { EMBEDDED_MIGRATIONS } from '../migrations.generated'
import { atlasMigrationsDirectory, loadAtlasMigrations } from '../migrations'
import { openStoreFixture } from './harness'

const authoredNames = (): string[] =>
  readdirSync(atlasMigrationsDirectory(), { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('_'))
    .map((entry) => entry.name)
    .sort()

describe('the migrations the shipped binary carries', () => {
  it('embeds every migration in the checkout, so a compiled build is not a schemaless database', () => {
    expect(EMBEDDED_MIGRATIONS.map((migration) => migration.name)).toEqual(authoredNames())
  })

  it('carries the SQL itself, not an empty placeholder', () => {
    expect(EMBEDDED_MIGRATIONS.length).toBeGreaterThan(0)
    for (const migration of EMBEDDED_MIGRATIONS) {
      expect(migration.sql.trim().length).toBeGreaterThan(0)
    }
  })

  it('matches what a checkout reads off disk, name for name and byte for byte', async () => {
    const fromDisk = await loadAtlasMigrations()
    expect(fromDisk).toEqual([...EMBEDDED_MIGRATIONS])
  })
})

describe('a freshly opened database', () => {
  it('reaches a queryable schema, because the tables are what the loop writes to', async () => {
    const fixture = await openStoreFixture()
    try {
      expect(await fixture.prisma.thread.count()).toBe(0)
    } finally {
      await fixture.close()
    }
  })
})
