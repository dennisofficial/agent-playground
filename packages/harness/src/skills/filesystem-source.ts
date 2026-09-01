import type { Dirent } from 'node:fs'
import { readFile, readdir, stat } from 'node:fs/promises'
import { basename, extname, join, resolve } from 'node:path'

import {
  isSkillEntryFilename,
  parseSkill,
  SkillSource,
  type DiscoveredSkill,
  type ESkillOrigin,
} from './skill'

const MARKDOWN_EXTENSION = '.md'

enum EEntryKind {
  Directory = 'directory',
  File = 'file',
  Other = 'other',
}

type SkillEntry = { directory: string; entryPath: string; fallbackName: string }

const readText = async (path: string): Promise<string | undefined> => {
  try {
    return await readFile(path, 'utf8')
  } catch {
    return undefined
  }
}

const kindOf = async (args: { dirent: Dirent; path: string }): Promise<EEntryKind> => {
  if (args.dirent.isDirectory()) return EEntryKind.Directory
  if (args.dirent.isFile()) return EEntryKind.File
  if (!args.dirent.isSymbolicLink()) return EEntryKind.Other

  try {
    const target = await stat(args.path)
    if (target.isDirectory()) return EEntryKind.Directory
    return target.isFile() ? EEntryKind.File : EEntryKind.Other
  } catch {
    return EEntryKind.Other
  }
}

const entryFilenameIn = async (directory: string): Promise<string | undefined> => {
  try {
    return (await readdir(directory)).find(isSkillEntryFilename)
  } catch {
    return undefined
  }
}

export class FilesystemSkillSource extends SkillSource {
  readonly origin: ESkillOrigin
  readonly directory: string

  constructor(args: { directory: string; origin: ESkillOrigin }) {
    super()
    this.directory = resolve(args.directory)
    this.origin = args.origin
  }

  async load(): Promise<readonly DiscoveredSkill[]> {
    const discovered: DiscoveredSkill[] = []

    for (const entry of await this.entries()) {
      const text = await readText(entry.entryPath)
      if (text === undefined) continue

      const skill = parseSkill({
        text,
        fallbackName: entry.fallbackName,
        origin: this.origin,
        directory: entry.directory,
        entryPath: entry.entryPath,
      })
      if (skill !== undefined) discovered.push(skill)
    }

    return discovered
  }

  private async entries(): Promise<readonly SkillEntry[]> {
    const entries: SkillEntry[] = []

    for (const dirent of await this.dirents()) {
      const path = join(this.directory, dirent.name)
      const kind = await kindOf({ dirent, path })

      if (kind === EEntryKind.Directory) {
        const filename = await entryFilenameIn(path)
        if (filename === undefined) continue
        entries.push({
          directory: path,
          entryPath: join(path, filename),
          fallbackName: dirent.name,
        })
        continue
      }

      if (kind !== EEntryKind.File) continue

      const extension = extname(dirent.name)
      if (extension.toLowerCase() !== MARKDOWN_EXTENSION) continue
      entries.push({
        directory: this.directory,
        entryPath: path,
        fallbackName: basename(dirent.name, extension),
      })
    }

    return entries
  }

  private async dirents(): Promise<readonly Dirent[]> {
    try {
      return await readdir(this.directory, { withFileTypes: true })
    } catch {
      return []
    }
  }
}
