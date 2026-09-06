import { stat } from 'node:fs/promises'

import { z } from 'zod'

import {
  EContentAccess,
  EPathForm,
  EPathPresence,
  EToolEffect,
  FileSystemPort,
  ProcessPort,
  SchemaTool,
  type DeclaredPathField,
  type RevealedLines,
  type ThreadId,
  type ToolOutcome,
  type ToolRun,
} from '@dltech/atlas-core'

import { LocalFileSystemPort } from '../../execution/local-filesystem'
import { LocalProcessPort } from '../../execution/local-process'
import { filePathSchema, resolveToolPath } from './file-text'
import { runPosixGrep } from './grep-fallback'
import { missingPathReason } from './missing-path'

const DEFAULT_HEAD_LIMIT = 250
const MAXIMUM_HEAD_LIMIT = 1_000
const MAXIMUM_LINE_LENGTH = 500
const NO_MATCH_EXIT_CODE = 1
const MAXIMUM_COMPLAINT_LENGTH = 500
const VERSION_CONTROL_DIRECTORIES = ['.git', '.svn', '.hg', '.jj', '.sl'] as const
const DIRECTORIES_RIPGREP_SKIPS_BY_GITIGNORE = ['node_modules'] as const

const inputSchema = z.strictObject({
  pattern: z.string().min(1),
  path: filePathSchema.optional(),
  glob: z.string().optional(),
  caseInsensitive: z.boolean().optional(),
  context: z.number().int().min(0).max(20).optional(),
  headLimit: z.number().int().min(1).max(MAXIMUM_HEAD_LIMIT).optional(),
  offset: z.number().int().min(0).optional(),
})

const description = [
  'Search file contents by regular expression and return the matching lines, each prefixed with its absolute path and line number.',
  'Searches the workspace root unless path names a narrower file or directory (a relative path resolves against the project directory), and glob narrows further by file name.',
  `Returns at most ${DEFAULT_HEAD_LIMIT} lines unless headLimit says otherwise; when more match, the result says so and offset asks for the next page.`,
  'Version control directories are never searched, and long lines are cut short.',
  'Symbolic links are followed.',
].join(' ')

type Searcher = { name: string; command: readonly string[] }

type SearchArguments = {
  pattern: string
  searchPath: string
  glob: string | undefined
  caseInsensitive: boolean
  context: number | undefined
}

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error))

function ripgrepSearcher(args: SearchArguments & { binary: string }): Searcher {
  return {
    name: 'ripgrep',
    command: [
      args.binary,
      '--with-filename',
      '--hidden',
      '--follow',
      ...VERSION_CONTROL_DIRECTORIES.flatMap((directory) => ['--glob', `!${directory}`]),
      '--max-columns',
      String(MAXIMUM_LINE_LENGTH),
      '--line-number',
      ...(args.caseInsensitive ? ['--ignore-case'] : []),
      ...(args.context === undefined ? [] : ['--context', String(args.context)]),
      ...(args.glob === undefined ? [] : ['--glob', args.glob]),
      '--regexp',
      args.pattern,
      args.searchPath,
    ],
  }
}

function searcherFor(
  args: SearchArguments & { processes: ProcessPort; threadId: ThreadId },
): Searcher | null {
  const binary = args.processes.which({ command: 'rg', threadId: args.threadId })
  return binary === null ? null : ripgrepSearcher({ ...args, binary })
}

export type GrepInput = z.output<typeof inputSchema>

export type GrepOutput = {
  pattern: string
  matches: readonly string[]
  paths: readonly string[]
  truncated: boolean
}

const isGrepOutput = (output: unknown): output is GrepOutput =>
  typeof output === 'object' &&
  output !== null &&
  Array.isArray((output as GrepOutput).paths) &&
  (output as GrepOutput).paths.every((path) => typeof path === 'string')

/**
 * ripgrep and POSIX grep both print a match as `path:line:text` and a context line as
 * `path-line-text`, so the colon separates a line the model was shown from one it was not.
 * The search root anchors the split, since a path may itself contain a colon.
 */
function matchedPathIn({
  line,
  searchPath,
}: {
  line: string
  searchPath: string
}): string | undefined {
  if (!line.startsWith(searchPath)) return undefined

  const separator = line.indexOf(':', searchPath.length)
  return separator === -1 ? undefined : line.slice(0, separator)
}

function pathsShownIn({
  window,
  searchPath,
}: {
  window: readonly string[]
  searchPath: string
}): string[] {
  const shown = new Set<string>()

  for (const line of window) {
    const path = matchedPathIn({ line, searchPath })
    if (path !== undefined) shown.add(path)
  }

  return [...shown]
}

const clampLine = (line: string): string =>
  line.length <= MAXIMUM_LINE_LENGTH ? line : line.slice(0, MAXIMUM_LINE_LENGTH)

const complaintFrom = (stderr: string): string =>
  stderr.replace(/\s+/g, ' ').trim().slice(0, MAXIMUM_COMPLAINT_LENGTH)

function renderModelText(args: {
  window: readonly string[]
  total: number
  offset: number
  complaint: string
}): string {
  const sections: string[] = []

  if (args.total === 0) sections.push('No matches found.')
  else if (args.window.length === 0) {
    sections.push(`No matches at offset ${args.offset}; there are ${args.total} matches in total.`)
  } else {
    sections.push(args.window.join('\n'))
    const next = args.offset + args.window.length
    if (next < args.total) {
      sections.push(
        `Showing matches ${args.offset + 1}-${next} of ${args.total}. Call grep again with offset: ${next} for the next page, or narrow the pattern.`,
      )
    }
  }

  if (args.complaint.length > 0) {
    sections.push(`Some paths could not be searched, so these results may be incomplete: ${args.complaint}`)
  }

  return sections.join('\n\n')
}

export class GrepTool extends SchemaTool<typeof inputSchema> {
  readonly name = 'grep'
  readonly description = description
  readonly effect = EToolEffect.Read
  override readonly isConcurrencySafe = (): boolean => true
  override readonly revealsLinesOf = ({
    output,
  }: RevealedLines<z.output<typeof inputSchema>>): readonly string[] =>
    isGrepOutput(output) ? output.paths : []
  readonly inputSchema = inputSchema
  override readonly pathFields: readonly DeclaredPathField[] = [
    { field: 'path', presence: EPathPresence.Optional, form: EPathForm.Absolute, content: EContentAccess.None },
  ]

  constructor(
    private readonly processes: ProcessPort = new LocalProcessPort(),
    private readonly files: FileSystemPort = new LocalFileSystemPort(),
  ) {
    super()
  }

  protected override async run({
    input,
    signal,
    projectDirectory,
    threadId,
  }: ToolRun<typeof inputSchema>): Promise<ToolOutcome> {
    const { pattern, glob, caseInsensitive, context, headLimit, offset } = input
    const rawPath = input.path
    const searchPath = resolveToolPath({ projectDirectory, path: rawPath ?? projectDirectory })

    if (rawPath !== undefined) {
      const target = await stat(searchPath).catch(() => null)
      if (target === null) {
        return {
          ok: false,
          reason: await missingPathReason({
            path: searchPath,
            ...(rawPath === searchPath
              ? {}
              : { resolvedFrom: { raw: rawPath, projectDirectory } }),
          }),
        }
      }
    }
    const searcher = searcherFor({
      pattern,
      searchPath,
      glob,
      caseInsensitive: caseInsensitive ?? false,
      context,
      processes: this.processes,
      threadId,
    })

    let stdout: string
    let stderr: string
    let exitCode: number
    try {
      if (searcher === null) {
        ;({ stdout, stderr, exitCode } = await runPosixGrep({
          pattern,
          searchPath,
          cwd: projectDirectory,
          include: glob,
          excludeSegments: [...VERSION_CONTROL_DIRECTORIES, ...DIRECTORIES_RIPGREP_SKIPS_BY_GITIGNORE],
          caseInsensitive: caseInsensitive ?? false,
          context,
          signal,
          processes: this.processes,
          files: this.files,
          threadId,
        }))
      } else {
        const search = this.processes.spawn({
          cmd: [...searcher.command],
          cwd: projectDirectory,
          threadId,
        })
        const handleAbort = (): void => search.terminate()
        signal.addEventListener('abort', handleAbort, { once: true })
        try {
          ;[stdout, stderr, exitCode] = await Promise.all([
            new Response(search.stdout).text(),
            new Response(search.stderr).text(),
            search.exited,
          ])
        } finally {
          signal.removeEventListener('abort', handleAbort)
        }
      }
    } catch (error) {
      return { ok: false, reason: `could not run ${searcher?.name ?? 'grep'}: ${messageOf(error)}` }
    }

    const lines = stdout
      .split('\n')
      .filter((line) => line.length > 0)
      .map(clampLine)

    const searchFailed = exitCode > NO_MATCH_EXIT_CODE
    const complaint = searchFailed ? complaintFrom(stderr) : ''

    if (searchFailed && lines.length === 0) {
      return {
        ok: false,
        reason: `${searcher?.name ?? 'grep'} exited ${exitCode}${complaint.length === 0 ? '' : `: ${complaint}`}`,
      }
    }

    const from = offset ?? 0
    const window = lines.slice(from, from + (headLimit ?? DEFAULT_HEAD_LIMIT))

    return {
      ok: true,
      output: {
        pattern,
        matches: window,
        paths: pathsShownIn({ window, searchPath }),
        truncated: from + window.length < lines.length,
      } satisfies GrepOutput,
      modelText: renderModelText({ window, total: lines.length, offset: from, complaint }),
    }
  }
}

