import { homedir } from 'node:os'
import { join } from 'node:path'

import { atlasHomeFrom } from '@dltech/atlas-core'

export { ATLAS_DIRECTORY_NAME, ATLAS_HOME_ENV } from '@dltech/atlas-core'

export const ATLAS_DATABASE_NAME = 'harness.db'
export const ATLAS_TAPES_DIRECTORY_NAME = 'tapes'
export const ATLAS_SERVICES_DIRECTORY_NAME = 'services'
export const ATLAS_BIN_DIRECTORY_NAME = 'bin'

// `bun build --compile` mounts the bundle on a virtual filesystem rooted at `/$bunfs`, so a module
// path under it means this is the shipped binary rather than a checkout.
// https://bun.sh/docs/bundler/executables
const EMBEDDED_ROOT = '/$bunfs'

export function isEmbeddedBuild(): boolean {
  return import.meta.dir.startsWith(EMBEDDED_ROOT)
}

export function atlasDirectory(): string {
  return atlasHomeFrom({ env: process.env, home: homedir() })
}

export function atlasTapesDirectory(): string {
  return join(atlasDirectory(), ATLAS_TAPES_DIRECTORY_NAME)
}

export function atlasServicesDirectory(): string {
  return join(atlasDirectory(), ATLAS_SERVICES_DIRECTORY_NAME)
}

export function atlasBinDirectory(): string {
  return join(atlasDirectory(), ATLAS_BIN_DIRECTORY_NAME)
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
