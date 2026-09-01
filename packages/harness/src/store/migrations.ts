import { join } from 'node:path'

import { loadMigrationsFromDir, type Migration } from 'prisma-adapter-bun-sqlite'

import { EMBEDDED_MIGRATIONS } from './migrations.generated'
import { isEmbeddedBuild } from './paths'

const MIGRATIONS_DIRECTORY = join(import.meta.dir, '..', '..', 'prisma', 'migrations')

export function atlasMigrationsDirectory(): string {
  return MIGRATIONS_DIRECTORY
}

/**
 * `loadMigrationsFromDir` answers an empty list for a directory that is not there, and the shipped
 * binary carries no `prisma/` directory at all — so the compiled build reads the generated manifest
 * instead of a path that would silently migrate nothing.
 */
export function loadAtlasMigrations(): Promise<Migration[]> {
  if (isEmbeddedBuild()) return Promise.resolve([...EMBEDDED_MIGRATIONS])

  return loadMigrationsFromDir(MIGRATIONS_DIRECTORY)
}
