import { z } from 'zod'

import {
  EContentAccess,
  EPathForm,
  EPathPresence,
  EToolEffect,
  FileSystemPort,
  SchemaTool,
  type DeclaredPathField,
  type ToolOutcome,
  type ToolRun,
} from '@dltech/atlas-core'

import { LocalFileSystemPort } from '../../execution/local-filesystem'
import { filePathSchema, resolveToolPath } from './file-text'

const RESULT_LIMIT = 100

const inputSchema = z.strictObject({
  pattern: z.string().min(1),
  path: filePathSchema.optional(),
})

const description = [
  'Find files by glob pattern and return their absolute paths, most recently modified first.',
  'Matches against the directory you are currently in unless path names a different one; a relative path resolves against the project directory.',
  `Returns at most ${RESULT_LIMIT} paths; when more match, the result says how many were left out.`,
  'Hidden files and directories are not matched.',
].join(' ')

type DatedPath = { path: string; modifiedAt: number }

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error))

async function modifiedAt(args: { path: string; files: FileSystemPort }): Promise<number> {
  const stats = await args.files.stat({ path: args.path }).catch(() => null)
  return stats?.mtimeMs ?? 0
}

function byNewestFirst(left: DatedPath, right: DatedPath): number {
  if (right.modifiedAt !== left.modifiedAt) return right.modifiedAt - left.modifiedAt
  return left.path.localeCompare(right.path)
}

function renderModelText(args: { paths: readonly string[]; total: number }): string {
  if (args.total === 0) return 'No files match that pattern.'
  if (args.paths.length >= args.total) return args.paths.join('\n')

  return [
    args.paths.join('\n'),
    `Showing the ${args.paths.length} most recently modified of ${args.total} matches. Narrow the pattern to see the rest.`,
  ].join('\n\n')
}

export class GlobTool extends SchemaTool<typeof inputSchema> {
  readonly name = 'glob'
  readonly description = description
  readonly effect = EToolEffect.Read
  override readonly isConcurrencySafe = (): boolean => true
  readonly inputSchema = inputSchema
  override readonly pathFields: readonly DeclaredPathField[] = [
    { field: 'path', presence: EPathPresence.Optional, form: EPathForm.Absolute, content: EContentAccess.None },
    { field: 'pattern', presence: EPathPresence.Required, form: EPathForm.RelativeToBase, content: EContentAccess.None },
  ]

  constructor(private readonly files: FileSystemPort = new LocalFileSystemPort()) {
    super()
  }

  protected override async run({
    input,
    signal,
    projectDirectory,
  }: ToolRun<typeof inputSchema>): Promise<ToolOutcome> {
    const { pattern, path } = input
    const from = path === undefined ? projectDirectory : resolveToolPath({ projectDirectory, path })

    let matches: readonly string[]
    try {
      matches = await this.files.glob({ pattern, cwd: from })
    } catch (error) {
      return { ok: false, reason: `could not scan ${from} for "${pattern}": ${messageOf(error)}` }
    }

    const found: DatedPath[] = []
    for (const match of matches) {
      if (signal.aborted) return { ok: false, reason: 'the developer interrupted the turn while scanning for files' }
      found.push({ path: match, modifiedAt: await modifiedAt({ path: match, files: this.files }) })
    }

    const paths = found.sort(byNewestFirst).slice(0, RESULT_LIMIT).map((dated) => dated.path)

    return {
      ok: true,
      output: { pattern, paths, truncated: paths.length < found.length },
      modelText: renderModelText({ paths, total: found.length }),
    }
  }
}

