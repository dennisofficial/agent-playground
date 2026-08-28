import { readFile, readdir } from 'node:fs/promises'
import { basename, extname, join } from 'node:path'

import { parseSkill, SkillSource, type DiscoveredSkill, type ESkillOrigin } from './skill'

const MARKDOWN_EXTENSION = '.md'
const NESTED_FILENAME = 'SKILL.md'

type SkillEntry = { name: string; nested: boolean }

const readText = async (path: string): Promise<string | undefined> => {
  try {
    return await readFile(path, 'utf8')
  } catch {
    return undefined
  }
}

export class FilesystemSkillSource extends SkillSource {
  readonly origin: ESkillOrigin
  private readonly directory: string

  constructor(args: { directory: string; origin: ESkillOrigin }) {
    super()
    this.directory = args.directory
    this.origin = args.origin
  }

  async load(): Promise<readonly DiscoveredSkill[]> {
    const entries = await this.entries()
    const discovered: DiscoveredSkill[] = []

    for (const entry of entries) {
      const found = entry.nested
        ? await this.read({
            path: join(this.directory, entry.name, NESTED_FILENAME),
            name: entry.name,
          })
        : await this.read({
            path: join(this.directory, entry.name),
            name: basename(entry.name, MARKDOWN_EXTENSION),
          })
      if (found !== undefined) discovered.push(found)
    }

    return discovered
  }

  private async entries(): Promise<readonly SkillEntry[]> {
    try {
      const found = await readdir(this.directory, { withFileTypes: true })
      return found.flatMap((entry): readonly SkillEntry[] => {
        if (entry.isDirectory()) return [{ name: entry.name, nested: true }]
        if (extname(entry.name).toLowerCase() !== MARKDOWN_EXTENSION) return []
        return [{ name: entry.name, nested: false }]
      })
    } catch {
      return []
    }
  }

  private async read(args: { path: string; name: string }): Promise<DiscoveredSkill | undefined> {
    const text = await readText(args.path)
    if (text === undefined) return undefined

    return parseSkill({ text, fallbackName: args.name, origin: this.origin })
  }
}
