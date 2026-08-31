import { readFile, readdir } from 'node:fs/promises'
import { basename, extname, join } from 'node:path'

import type { EDefinitionOrigin } from '@dltech/atlas-core'

import {
  AgentTypeSource,
  parseAgentType,
  type AgentType,
  type AgentTypeRead,
  type AgentTypeRefusal,
  EAgentTypeRefusal,
} from './agent-type'

const MARKDOWN_EXTENSION = '.md'

const ABSENT_DIRECTORY = 'ENOENT'

export type MarkdownFile = { name: string; path: string; text: string }

export type UnreadableMarkdown = { path: string; detail: string }

export type MarkdownDirectoryRead = {
  files: readonly MarkdownFile[]
  unreadable: readonly UnreadableMarkdown[]
}

export type MarkdownDirectoryReader = (directory: string) => Promise<MarkdownDirectoryRead>

const codeOf = (error: unknown): string | undefined => {
  if (typeof error !== 'object' || error === null) return undefined
  if (!('code' in error)) return undefined
  return typeof error.code === 'string' ? error.code : undefined
}

const detailOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

export const readMarkdownDirectory: MarkdownDirectoryReader = async (directory) => {
  let names: readonly string[]
  try {
    const entries = await readdir(directory, { withFileTypes: true })
    names = entries
      .filter((entry) => entry.isFile() && extname(entry.name).toLowerCase() === MARKDOWN_EXTENSION)
      .map((entry) => entry.name)
  } catch (error) {
    if (codeOf(error) === ABSENT_DIRECTORY) return { files: [], unreadable: [] }
    return { files: [], unreadable: [{ path: directory, detail: detailOf(error) }] }
  }

  const read = await Promise.all(
    names.map(async (name): Promise<MarkdownDirectoryRead> => {
      const path = join(directory, name)
      try {
        return { files: [{ name, path, text: await readFile(path, 'utf8') }], unreadable: [] }
      } catch (error) {
        return { files: [], unreadable: [{ path, detail: detailOf(error) }] }
      }
    }),
  )

  return {
    files: read.flatMap((entry) => entry.files),
    unreadable: read.flatMap((entry) => entry.unreadable),
  }
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

  async load(): Promise<AgentTypeRead> {
    const { files, unreadable } = await this.read(this.directory)

    const types: AgentType[] = []
    const refusals: AgentTypeRefusal[] = unreadable.map((entry) => ({
      refusal: EAgentTypeRefusal.Unreadable,
      name: undefined,
      definedIn: entry.path,
      origin: this.origin,
      detail: entry.detail,
    }))

    for (const file of files) {
      const parsed = parseAgentType({
        text: file.text,
        fallbackName: basename(file.name, MARKDOWN_EXTENSION),
        origin: this.origin,
        definedIn: file.path,
      })

      if (parsed.ok) {
        types.push(parsed.agentType)
        continue
      }

      refusals.push({
        refusal: parsed.refusal,
        name: parsed.name,
        definedIn: file.path,
        origin: this.origin,
        detail: parsed.detail,
      })
    }

    return { types, refusals }
  }
}
