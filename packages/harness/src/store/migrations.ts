import { join } from 'node:path'

import { loadMigrationsFromDir, type Migration } from 'prisma-adapter-bun-sqlite'

const MIGRATIONS_DIRECTORY = join(import.meta.dir, '..', '..', 'prisma', 'migrations')

export function atlasMigrationsDirectory(): string {
  return MIGRATIONS_DIRECTORY
}

export function loadAtlasMigrations(): Promise<Migration[]> {
  return loadMigrationsFromDir(MIGRATIONS_DIRECTORY)
}
