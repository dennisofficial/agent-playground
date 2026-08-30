import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

import { atlasHomeFrom } from '@dltech/atlas-core'

export { ATLAS_DIRECTORY_NAME, ATLAS_HOME_ENV } from '@dltech/atlas-core'

export const ATLAS_DATABASE_NAME = 'harness.db'
export const ATLAS_TAPES_DIRECTORY_NAME = 'tapes'

const WORKSPACE_MARKER = 'bun.lock'

// `bun build --compile` mounts the bundle on a virtual filesystem rooted at `/$bunfs`, so a module
// path under it means this is the shipped binary rather than a checkout.
// https://bun.sh/docs/bundler/executables
const EMBEDDED_ROOT = '/$bunfs'

const workspaceRootAbove = (directory: string): string | null => {
  let at = directory
  for (;;) {
    if (existsSync(join(at, WORKSPACE_MARKER))) return at

    const parent = dirname(at)
    if (parent === at) return null
    at = parent
  }
}

let resolvedSourceRoot: string | null | undefined

const sourceRoot = (): string | null => {
  if (resolvedSourceRoot !== undefined) return resolvedSourceRoot

  resolvedSourceRoot = import.meta.dir.startsWith(EMBEDDED_ROOT)
    ? null
    : workspaceRootAbove(import.meta.dir)

  return resolvedSourceRoot
}

export function atlasDirectory(): string {
  return atlasHomeFrom({ env: process.env, home: homedir(), sourceRoot: sourceRoot() })
}

export function atlasTapesDirectory(): string {
  return join(atlasDirectory(), ATLAS_TAPES_DIRECTORY_NAME)
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
