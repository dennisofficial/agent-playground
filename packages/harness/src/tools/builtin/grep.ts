import { z } from 'zod'

import { EPathForm, EPathPresence, EToolEffect, type ToolDefinition, type ToolOutcome } from '@dltech/atlas-core'

import { absolutePathSchema } from './file-text'

const DEFAULT_HEAD_LIMIT = 250
const MAXIMUM_HEAD_LIMIT = 1_000
const MAXIMUM_LINE_LENGTH = 500
const NO_MATCH_EXIT_CODE = 1
const MAXIMUM_COMPLAINT_LENGTH = 500
const VERSION_CONTROL_DIRECTORIES = ['.git', '.svn', '.hg', '.jj', '.sl'] as const
const DIRECTORIES_RIPGREP_SKIPS_BY_GITIGNORE = ['node_modules'] as const

const inputSchema = z.strictObject({
  pattern: z.string().min(1),
  path: absolutePathSchema.optional(),
  glob: z.string().optional(),
  caseInsensitive: z.boolean().optional(),
  context: z.number().int().min(0).max(20).optional(),
  headLimit: z.number().int().min(1).max(MAXIMUM_HEAD_LIMIT).optional(),
  offset: z.number().int().min(0).optional(),
})

const description = [
  'Search file contents by regular expression and return the matching lines, each prefixed with its absolute path and line number.',
  'Searches the workspace root unless path names a narrower file or directory, which must be absolute, and glob narrows further by file name.',
  `Returns at most ${DEFAULT_HEAD_LIMIT} lines unless headLimit says otherwise; when more match, the result says so and offset asks for the next page.`,
  'Version control directories are never searched, and long lines are cut short.',
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

/**
 * Bun.which resolves against the PATH captured when the process started and ignores later writes to
 * process.env.PATH unless the PATH option is passed explicitly.
 * https://bun.sh/docs/api/utils#bun-which
 */
function ripgrepBinary(): string | null {
  const path = process.env.PATH
  return path === undefined ? Bun.which('rg') : Bun.which('rg', { PATH: path })
}

function ripgrepSearcher(args: SearchArguments & { binary: string }): Searcher {
  return {
    name: 'ripgrep',
    command: [
      args.binary,
      '--hidden',
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

function posixGrepSearcher(args: SearchArguments): Searcher {
  return {
    name: 'grep',
    command: [
      'grep',
      '-r',
      '-n',
      '-I',
      '-E',
      ...[...VERSION_CONTROL_DIRECTORIES, ...DIRECTORIES_RIPGREP_SKIPS_BY_GITIGNORE].map(
        (directory) => `--exclude-dir=${directory}`,
      ),
      ...(args.caseInsensitive ? ['-i'] : []),
      ...(args.context === undefined ? [] : ['-C', String(args.context)]),
      ...(args.glob === undefined ? [] : [`--include=${args.glob}`]),
      '-e',
      args.pattern,
      args.searchPath,
    ],
  }
}

function searcherFor(args: SearchArguments): Searcher {
  const binary = ripgrepBinary()
  return binary === null ? posixGrepSearcher(args) : ripgrepSearcher({ ...args, binary })
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

export function createGrepTool(args: { root: string }): ToolDefinition {
  return {
    name: 'grep',
    description,
    effect: EToolEffect.Read,
    inputSchema,
    pathFields: [{ field: 'path', presence: EPathPresence.Optional, form: EPathForm.Absolute }],
    invoke: async ({ input, signal }): Promise<ToolOutcome> => {
      const parsed = inputSchema.safeParse(input)
      if (!parsed.success) {
        return { ok: false, reason: `grep was called with invalid input: ${z.prettifyError(parsed.error)}` }
      }

      const { pattern, path, glob, caseInsensitive, context, headLimit, offset } = parsed.data
      const searcher = searcherFor({
        pattern,
        searchPath: path ?? args.root,
        glob,
        caseInsensitive: caseInsensitive ?? false,
        context,
      })

      let stdout: string
      let stderr: string
      let exitCode: number
      try {
        const search = Bun.spawn({
          cmd: [...searcher.command],
          cwd: args.root,
          stdin: 'ignore',
          stdout: 'pipe',
          stderr: 'pipe',
        })
        const handleAbort = (): void => void search.kill('SIGTERM')
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
      } catch (error) {
        return { ok: false, reason: `could not run ${searcher.name}: ${messageOf(error)}` }
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
          reason: `${searcher.name} exited ${exitCode}${complaint.length === 0 ? '' : `: ${complaint}`}`,
        }
      }

      const from = offset ?? 0
      const window = lines.slice(from, from + (headLimit ?? DEFAULT_HEAD_LIMIT))

      return {
        ok: true,
        output: { pattern, matches: window, truncated: from + window.length < lines.length },
        modelText: renderModelText({ window, total: lines.length, offset: from, complaint }),
      }
    },
  }
}
