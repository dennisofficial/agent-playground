import { homedir } from 'node:os'
import { join } from 'node:path'

export const ATLAS_DIRECTORY_NAME = '.atlas'
export const ATLAS_DATABASE_NAME = 'harness.db'

export function atlasDirectory(): string {
  return join(homedir(), ATLAS_DIRECTORY_NAME)
}

export function atlasDatabaseFile(): string {
  return join(atlasDirectory(), ATLAS_DATABASE_NAME)
}

export function atlasDatabaseUrl(): string {
  return `file:${atlasDatabaseFile()}`
}

export function databaseFileFromUrl(databaseUrl: string): string {
  return databaseUrl.replace(/^file:/, '')
}
