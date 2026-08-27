import { statSync } from 'node:fs'

import { z } from 'zod'

import {
  EContentAccess,
  EPathForm,
  EPathPresence,
  EToolEffect,
  SchemaTool,
  type DeclaredPathField,
  type ToolOutcome,
  type ToolRun,
} from '@dltech/atlas-core'

import { inject, injectable } from '../../container/injection'
import { WorkspaceRoot } from '../../container/tokens'
import { createWorkspaceContainment, type WorkspaceContainment } from '../containment'
import { absolutePathSchema } from './file-text'

const RESULT_LIMIT = 100

const inputSchema = z.strictObject({
  pattern: z.string().min(1),
  path: absolutePathSchema.optional(),
})

const description = [
  'Find files by glob pattern and return their absolute paths, most recently modified first.',
  'Matches against the workspace root unless path names a different directory, which must be absolute.',
  `Returns at most ${RESULT_LIMIT} paths; when more match, the result says how many were left out.`,
  'Hidden files and directories are not matched.',
].join(' ')

type DatedPath = { path: string; modifiedAt: number }

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error))

function modifiedAt(path: string): number {
  try {
    return statSync(path).mtimeMs
  } catch {
    return 0
  }
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

@injectable()
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

  private readonly containment: WorkspaceContainment

  constructor(@inject(WorkspaceRoot) private readonly root: string) {
    super()
    this.containment = createWorkspaceContainment({ root })
  }

  protected override async run({ input, signal }: ToolRun<typeof inputSchema>): Promise<ToolOutcome> {
    const { pattern, path } = input
    const from = path ?? this.root

    const found: DatedPath[] = []
    try {
      const scan = new Bun.Glob(pattern).scan({ cwd: from, absolute: true, onlyFiles: true })
      for await (const match of scan) {
        if (signal.aborted) return { ok: false, reason: 'the developer interrupted the turn while scanning for files' }
        if (!(await this.containment.contains(match))) continue
        found.push({ path: match, modifiedAt: modifiedAt(match) })
      }
    } catch (error) {
      return { ok: false, reason: `could not scan ${from} for "${pattern}": ${messageOf(error)}` }
    }

    const paths = found.sort(byNewestFirst).slice(0, RESULT_LIMIT).map((dated) => dated.path)

    return {
      ok: true,
      output: { pattern, paths, truncated: paths.length < found.length },
      modelText: renderModelText({ paths, total: found.length }),
    }
  }
}

