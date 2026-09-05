import { readdir, readFile, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'

import { isUnderPath, type DirectoryEntry } from '@dltech/atlas-core'

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

/**
 * The directories the thread's execution environment can actually read: the project plus whatever
 * is mounted into the container. Undefined means the open host filesystem. A getter, because the
 * thread column can move the session between the two mid-conversation.
 */
export type ReachableRoots = () => readonly string[] | undefined

const reachable = (args: { roots: readonly string[]; path: string }): boolean =>
  args.roots.some((root) => isUnderPath({ directory: root, path: args.path }))

const aboveARoot = (args: { roots: readonly string[]; directory: string }): boolean =>
  args.roots.some((root) => isUnderPath({ directory: args.directory, path: root }))

export class FileBrowser {
  private readonly root: string
  private readonly reachableRoots: ReachableRoots | undefined
  private readonly levels = new Map<string, Promise<readonly DirectoryEntry[]>>()
  private readonly known = new Map<string, Promise<boolean>>()

  constructor(args: { root: string; reachableRoots?: ReachableRoots | undefined }) {
    this.root = args.root
    this.reachableRoots = args.reachableRoots
  }

  list(directory: string): Promise<readonly DirectoryEntry[]> {
    const held = this.levels.get(directory)
    if (held !== undefined) return held

    const reading = this.listLevel(directory)
    this.levels.set(directory, reading)
    return reading
  }

  private async listLevel(directory: string): Promise<readonly DirectoryEntry[]> {
    const full = resolveMentionPath({ root: this.root, path: directory })
    const roots = this.reachableRoots?.()
    if (roots === undefined || reachable({ roots, path: full })) return entriesOf(full)
    if (!aboveARoot({ roots, directory: full })) return []

    const entries = await entriesOf(full)
    return entries.filter((entry) => {
      const path = join(full, entry.name)
      return reachable({ roots, path }) || aboveARoot({ roots, directory: path })
    })
  }

  exists(path: string): Promise<boolean> {
    const held = this.known.get(path)
    if (held !== undefined) return held

    const asking = this.checkExists(path)
    this.known.set(path, asking)
    return asking
  }

  private async checkExists(path: string): Promise<boolean> {
    const full = resolveMentionPath({ root: this.root, path })
    const roots = this.reachableRoots?.()
    if (roots !== undefined && !reachable({ roots, path: full })) return false

    return await stat(full)
      .then(() => true)
      .catch(() => false)
  }

  forget(): void {
    this.levels.clear()
    this.known.clear()
  }

  async load(path: string): Promise<LoadedFile> {
    const full = resolveMentionPath({ root: this.root, path })
    const roots = this.reachableRoots?.()
    if (roots !== undefined && !reachable({ roots, path: full })) {
      return {
        type: EFileLoad.Refused,
        path,
        reason: 'it is outside what the sandbox can reach',
      }
    }

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
