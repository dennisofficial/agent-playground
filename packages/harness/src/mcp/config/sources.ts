import { readFile } from 'node:fs/promises'

import { EDefinitionOrigin } from '@dltech/atlas-core'

import {
  compatMcpFile,
  projectMcpFile,
  userMcpFile,
} from '../../settings/paths'
import {
  mcpConfigFileSchema,
  mcpServersOf,
  mcpSpecSchema,
  type ParsedMcpSpec,
} from './specs'

export enum EMcpRejection {
  Unreadable = 'unreadable',
  NotJson = 'not-json',
  BadShape = 'bad-shape',
  BadEntry = 'bad-entry',
  BadName = 'bad-name',
}

export type McpRejection = {
  rejection: EMcpRejection
  name: string | undefined
  definedIn: string
  origin: EDefinitionOrigin
  detail: string
}

export type LoadedMcpSpec = ParsedMcpSpec & {
  origin: EDefinitionOrigin
  definedIn: string
}

export type McpSourceRead = {
  specs: readonly LoadedMcpSpec[]
  rejections: readonly McpRejection[]
}

export abstract class McpSource {
  abstract readonly origin: EDefinitionOrigin
  abstract load(): Promise<McpSourceRead>
}

export class BuiltInMcpSource extends McpSource {
  readonly origin = EDefinitionOrigin.BuiltIn

  async load(): Promise<McpSourceRead> {
    return { specs: [], rejections: [] }
  }
}

export type McpTextReader = (file: string) => Promise<string>

const ABSENT_FILE = 'ENOENT'

const MAX_REPORTED_ISSUES = 5

const codeOf = (error: unknown): string | undefined => {
  if (typeof error !== 'object' || error === null) return undefined
  if (!('code' in error)) return undefined
  return typeof error.code === 'string' ? error.code : undefined
}

const detailOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

export const readMcpFileText: McpTextReader = (file) => readFile(file, 'utf8')

const formatIssues = (
  issues: readonly { path: readonly PropertyKey[]; message: string }[],
): string =>
  issues
    .slice(0, MAX_REPORTED_ISSUES)
    .map((issue) => {
      const field = issue.path.map(String).join('.')
      return field === '' ? issue.message : `${field}: ${issue.message}`
    })
    .join('; ')

const nameIsValid = (name: string): boolean =>
  mcpSpecSchema.shape.name.safeParse(name).success

function readMcpJson(args: { text: string; file: string; origin: EDefinitionOrigin }): McpSourceRead {
  const rejections: McpRejection[] = []
  const reject = (rejection: Omit<McpRejection, 'definedIn' | 'origin'>): void => {
    rejections.push({ ...rejection, definedIn: args.file, origin: args.origin })
  }

  let parsedJson: unknown
  try {
    parsedJson = JSON.parse(args.text)
  } catch (error) {
    reject({ rejection: EMcpRejection.NotJson, name: undefined, detail: detailOf(error) })
    return { specs: [], rejections }
  }

  const file = mcpConfigFileSchema.safeParse(parsedJson)
  if (!file.success) {
    reject({
      rejection: EMcpRejection.BadShape,
      name: undefined,
      detail: formatIssues(file.error.issues),
    })
    return { specs: [], rejections }
  }

  const specs: LoadedMcpSpec[] = []
  for (const [name, entry] of Object.entries(mcpServersOf(file.data))) {
    const fields = typeof entry === 'object' && entry !== null ? entry : {}
    const parsed = mcpSpecSchema.safeParse({ ...fields, name })

    if (parsed.success) {
      specs.push({ ...parsed.data, origin: args.origin, definedIn: args.file })
      continue
    }

    reject({
      rejection: nameIsValid(name) ? EMcpRejection.BadEntry : EMcpRejection.BadName,
      name,
      detail: formatIssues(parsed.error.issues),
    })
  }

  return { specs, rejections }
}

abstract class FileBackedMcpSource extends McpSource {
  protected constructor(
    private readonly args: { file: string; read: McpTextReader },
  ) {
    super()
  }

  async load(): Promise<McpSourceRead> {
    let text: string
    try {
      text = await this.args.read(this.args.file)
    } catch (error) {
      if (codeOf(error) === ABSENT_FILE) return { specs: [], rejections: [] }
      return {
        specs: [],
        rejections: [
          {
            rejection: EMcpRejection.Unreadable,
            name: undefined,
            definedIn: this.args.file,
            origin: this.origin,
            detail: detailOf(error),
          },
        ],
      }
    }

    return readMcpJson({ text, file: this.args.file, origin: this.origin })
  }
}

export class FileMcpSource extends FileBackedMcpSource {
  readonly origin: EDefinitionOrigin

  constructor(args: { file: string; origin: EDefinitionOrigin; read?: McpTextReader }) {
    super({ file: args.file, read: args.read ?? readMcpFileText })
    this.origin = args.origin
  }

  static user(args?: { read?: McpTextReader }): FileMcpSource {
    return new FileMcpSource({
      file: userMcpFile(),
      origin: EDefinitionOrigin.User,
      ...(args?.read !== undefined ? { read: args.read } : {}),
    })
  }

  static project(args: { cwd: string; read?: McpTextReader }): FileMcpSource {
    return new FileMcpSource({
      file: projectMcpFile(args.cwd),
      origin: EDefinitionOrigin.Project,
      ...(args.read !== undefined ? { read: args.read } : {}),
    })
  }
}

// Claude Code's compat file format, read from the project root only: no parent walk.
export class CompatMcpSource extends FileBackedMcpSource {
  readonly origin = EDefinitionOrigin.Project

  constructor(args: { cwd: string; read?: McpTextReader }) {
    super({ file: compatMcpFile(args.cwd), read: args.read ?? readMcpFileText })
  }
}
