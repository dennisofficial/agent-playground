import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export type TempDatabase = { databaseUrl: string; discard: () => void }

export function createTempDatabase(): TempDatabase {
  const directory = mkdtempSync(join(tmpdir(), 'atlas-loop-'))
  return {
    databaseUrl: `file:${join(directory, 'harness.db')}`,
    discard: () => rmSync(directory, { recursive: true, force: true }),
  }
}
