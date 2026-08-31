import { readFile, readdir } from 'node:fs/promises'
import { basename, extname, join } from 'node:path'

import type { EDefinitionOrigin } from '@dltech/atlas-core'

import { AgentTypeSource, parseAgentType, type AgentType } from './agent-type'

const MARKDOWN_EXTENSION = '.md'

export type MarkdownFile = { name: string; text: string }
export type MarkdownDirectoryReader = (directory: string) => Promise<readonly MarkdownFile[]>

export const readMarkdownDirectory: MarkdownDirectoryReader = async (directory) => {
  let names: readonly string[]
  try {
    const entries = await readdir(directory, { withFileTypes: true })
    names = entries
      .filter((entry) => entry.isFile() && extname(entry.name).toLowerCase() === MARKDOWN_EXTENSION)
      .map((entry) => entry.name)
  } catch {
    return []
  }

  const read = await Promise.all(
    names.map(async (name): Promise<readonly MarkdownFile[]> => {
      try {
        return [{ name, text: await readFile(join(directory, name), 'utf8') }]
      } catch {
        return []
      }
    }),
  )

  return read.flat()
}

export class DirectoryAgentTypeSource extends AgentTypeSource {
  readonly origin: EDefinitionOrigin
  private readonly directory: string
  private readonly read: MarkdownDirectoryReader

  constructor(args: {
    directory: string
    origin: EDefinitionOrigin
    read?: MarkdownDirectoryReader
  }) {
    super()
    this.directory = args.directory
    this.origin = args.origin
    this.read = args.read ?? readMarkdownDirectory
  }

  async load(): Promise<readonly AgentType[]> {
    const files = await this.read(this.directory)

    return files.flatMap((file): readonly AgentType[] => {
      const parsed = parseAgentType({
        text: file.text,
        fallbackName: basename(file.name, MARKDOWN_EXTENSION),
        origin: this.origin,
      })
      return parsed === undefined ? [] : [parsed]
    })
  }
}
