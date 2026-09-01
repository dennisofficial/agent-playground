import type { Dirent } from 'node:fs'
import { readdir } from 'node:fs/promises'
import { extname, join } from 'node:path'

import {
  EPluginRefusal,
  refuseDuplicateIds,
  validateRepoPlugin,
  type LoadedRepoPlugin,
  type RepoPluginOrigin,
  type RepoPluginRead,
  type RepoPluginRefusal,
} from './validate'

const PLUGIN_EXTENSIONS: readonly string[] = ['.ts', '.tsx']

const DECLARATION_SUFFIX = '.d.ts'

const ABSENT_DIRECTORY = 'ENOENT'

export type PluginModuleImporter = (path: string) => Promise<unknown>

export type UnreadablePluginPath = { path: string; detail: string }

export type PluginDirectoryListing = {
  paths: readonly string[]
  unreadable: readonly UnreadablePluginPath[]
}

const codeOf = (error: unknown): string | undefined => {
  if (typeof error !== 'object' || error === null) return undefined
  if (!('code' in error)) return undefined
  return typeof error.code === 'string' ? error.code : undefined
}

const detailOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

const isPluginFile = (name: string): boolean =>
  !name.startsWith('.') &&
  !name.endsWith(DECLARATION_SUFFIX) &&
  PLUGIN_EXTENSIONS.includes(extname(name))

const indexWithin = async (directory: string): Promise<string | UnreadablePluginPath> => {
  try {
    const names = await readdir(directory)
    const index = PLUGIN_EXTENSIONS.map((extension) => `index${extension}`).find((candidate) =>
      names.includes(candidate),
    )

    if (index === undefined) {
      return { path: directory, detail: 'the directory holds no index.ts or index.tsx' }
    }

    return join(directory, index)
  } catch (error) {
    return { path: directory, detail: detailOf(error) }
  }
}

export async function listPluginPaths(directory: string): Promise<PluginDirectoryListing> {
  let entries: readonly Dirent[]
  try {
    entries = await readdir(directory, { withFileTypes: true })
  } catch (error) {
    if (codeOf(error) === ABSENT_DIRECTORY) return { paths: [], unreadable: [] }
    return { paths: [], unreadable: [{ path: directory, detail: detailOf(error) }] }
  }

  const named = [...entries].sort((left, right) => (left.name < right.name ? -1 : 1))

  const paths: string[] = []
  const unreadable: UnreadablePluginPath[] = []

  for (const entry of named) {
    if (entry.isFile() && isPluginFile(entry.name)) {
      paths.push(join(directory, entry.name))
      continue
    }

    if (!entry.isDirectory() || entry.name.startsWith('.')) continue

    const found = await indexWithin(join(directory, entry.name))
    if (typeof found === 'string') paths.push(found)
    else unreadable.push(found)
  }

  return { paths, unreadable }
}

export const importPluginModule: PluginModuleImporter = (path) => import(path)

export async function loadPluginDirectory(args: {
  directory: string
  origin: RepoPluginOrigin
  importModule?: PluginModuleImporter
}): Promise<RepoPluginRead> {
  const importModule = args.importModule ?? importPluginModule
  const listing = await listPluginPaths(args.directory)

  const loaded: LoadedRepoPlugin[] = []
  const refusals: RepoPluginRefusal[] = listing.unreadable.map((entry) => ({
    refusal: EPluginRefusal.Unreadable,
    id: undefined,
    definedIn: entry.path,
    origin: args.origin,
    detail: entry.detail,
  }))

  for (const path of listing.paths) {
    let module: unknown
    try {
      module = await importModule(path)
    } catch (error) {
      refusals.push({
        refusal: EPluginRefusal.Unreadable,
        id: undefined,
        definedIn: path,
        origin: args.origin,
        detail: detailOf(error),
      })
      continue
    }

    const validated = validateRepoPlugin(module)
    if (!validated.ok) {
      refusals.push({
        refusal: validated.refusal,
        id: validated.id,
        definedIn: path,
        origin: args.origin,
        detail: validated.detail,
      })
      continue
    }

    loaded.push({ plugin: validated.plugin, definedIn: path, origin: args.origin })
  }

  const deduped = refuseDuplicateIds(loaded)

  return { plugins: deduped.plugins, refusals: [...refusals, ...deduped.refusals] }
}
