import { readdir, readFile, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'

import type { DirectoryEntry } from '@dltech/atlas-core'

export const MAX_MENTION_BYTES = 128 * 1024
export const MAX_LEVEL_ENTRIES = 500

export enum EFileLoad {
  Text = 'text',
  Listing = 'listing',
  Refused = 'refused',
}

export type LoadedFile =
  | { type: EFileLoad.Text; path: string; content: string; truncated: boolean }
  | { type: EFileLoad.Listing; path: string; content: string }
  | { type: EFileLoad.Refused; path: string; reason: string }

const HOME_PREFIX = '~'

export function resolveMentionPath(args: { root: string; path: string }): string {
  const { path } = args
  if (path === HOME_PREFIX) return homedir()
  if (path.startsWith(`${HOME_PREFIX}/`)) return join(homedir(), path.slice(2))
  if (isAbsolute(path)) return path

  return resolve(args.root, path)
}

const entriesOf = async (directory: string): Promise<readonly DirectoryEntry[]> => {
  const read = await readdir(directory, { withFileTypes: true }).catch(() => null)
  if (read === null) return []

  return read
    .map((entry) => ({ name: entry.name, isDirectory: entry.isDirectory() }))
    .sort((left, right) => left.name.localeCompare(right.name))
    .slice(0, MAX_LEVEL_ENTRIES)
}

export class FileBrowser {
  private readonly root: string
  private readonly levels = new Map<string, Promise<readonly DirectoryEntry[]>>()
  private readonly known = new Map<string, Promise<boolean>>()

  constructor(args: { root: string }) {
    this.root = args.root
  }

  list(directory: string): Promise<readonly DirectoryEntry[]> {
    const held = this.levels.get(directory)
    if (held !== undefined) return held

    const reading = entriesOf(resolveMentionPath({ root: this.root, path: directory }))
    this.levels.set(directory, reading)
    return reading
  }

  exists(path: string): Promise<boolean> {
    const held = this.known.get(path)
    if (held !== undefined) return held

    const asking = stat(resolveMentionPath({ root: this.root, path }))
      .then(() => true)
      .catch(() => false)

    this.known.set(path, asking)
    return asking
  }

  forget(): void {
    this.levels.clear()
    this.known.clear()
  }

  async load(path: string): Promise<LoadedFile> {
    const full = resolveMentionPath({ root: this.root, path })

    const found = await stat(full).catch(() => null)
    if (found === null) return { type: EFileLoad.Refused, path, reason: 'it does not exist' }

    if (found.isDirectory()) {
      const entries = await entriesOf(full)
      const listed = entries
        .map((entry) => (entry.isDirectory ? `${entry.name}/` : entry.name))
        .sort()

      return { type: EFileLoad.Listing, path, content: listed.join('\n') }
    }

    if (!found.isFile()) return { type: EFileLoad.Refused, path, reason: 'it is not a file' }

    const read = await readFile(full).catch(() => null)
    if (read === null) return { type: EFileLoad.Refused, path, reason: 'it could not be read' }
    if (read.includes(0)) return { type: EFileLoad.Refused, path, reason: 'it is binary' }

    const truncated = read.byteLength > MAX_MENTION_BYTES
    const kept = truncated ? read.subarray(0, MAX_MENTION_BYTES) : read

    return { type: EFileLoad.Text, path, content: kept.toString('utf8'), truncated }
  }
}
