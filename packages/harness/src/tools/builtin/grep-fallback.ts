import type { FileSystemPort, ProcessPort, ThreadId } from '@dltech/atlas-core'

const FILES_PER_GREP_BATCH = 128

export type SearchResult = {
  stdout: string
  stderr: string
  exitCode: number
}

export type FallbackSearch = {
  pattern: string
  searchPath: string
  cwd: string
  include: string | undefined
  excludeSegments: readonly string[]
  caseInsensitive: boolean
  context: number | undefined
  signal: AbortSignal
  processes: ProcessPort
  files: FileSystemPort
  threadId: ThreadId
}

const NO_MATCH_EXIT_CODE = 1

const relativeToRoot = (path: string, root: string): string => path.slice(root.length + 1)

const touchesExcludedSegment = (relative: string, excludeSegments: readonly string[]): boolean =>
  relative.split('/').some((segment) => excludeSegments.includes(segment))

function batchesOf(files: readonly string[]): string[][] {
  const batches: string[][] = []
  for (let index = 0; index < files.length; index += FILES_PER_GREP_BATCH) {
    batches.push(files.slice(index, index + FILES_PER_GREP_BATCH))
  }
  return batches
}

async function spawnGrep(args: FallbackSearch & { cmd: readonly string[] }): Promise<SearchResult> {
  const search = args.processes.spawn({
    cmd: [...args.cmd],
    cwd: args.cwd,
    threadId: args.threadId,
  })
  const handleAbort = (): void => search.terminate()
  args.signal.addEventListener('abort', handleAbort, { once: true })
  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(search.stdout).text(),
      new Response(search.stderr).text(),
      search.exited,
    ])
    return { stdout, stderr, exitCode }
  } finally {
    args.signal.removeEventListener('abort', handleAbort)
  }
}

function grepFlags(args: FallbackSearch): string[] {
  return [
    '-n',
    '-I',
    '-E',
    ...(args.caseInsensitive ? ['-i'] : []),
    ...(args.context === undefined ? [] : ['-C', String(args.context)]),
    '-e',
    args.pattern,
  ]
}

/**
 * The fallback for machines without ripgrep. Apple's BSD grep follows no symlink during
 * recursion — not even with -R, and not even a symlinked directory handed to it directly — so
 * the file list is enumerated through the filesystem port (which follows links safely) and
 * grep runs over explicit files in batches.
 */
export async function runPosixGrep(args: FallbackSearch): Promise<SearchResult> {
  const target = await args.files.stat({ path: args.searchPath }).catch(() => null)

  if (target !== null && target.isFile()) {
    return await spawnGrep({ ...args, cmd: ['grep', '-H', ...grepFlags(args), '--', args.searchPath] })
  }

  const include = args.include === undefined ? null : new Bun.Glob(`**/${args.include}`)
  const candidates = (await args.files.glob({ pattern: '**/*', cwd: args.searchPath, dot: true })).filter(
    (path) => {
      const relative = relativeToRoot(path, args.searchPath)
      return !touchesExcludedSegment(relative, args.excludeSegments) && (include === null || include.match(relative))
    },
  )

  if (candidates.length === 0) return { stdout: '', stderr: '', exitCode: NO_MATCH_EXIT_CODE }

  let stdout = ''
  let stderr = ''
  let sawError = false
  let sawMatch = false
  for (const batch of batchesOf(candidates)) {
    const result = await spawnGrep({ ...args, cmd: ['grep', '-H', ...grepFlags(args), '--', ...batch] })
    stdout += result.stdout
    if (result.exitCode > NO_MATCH_EXIT_CODE) {
      sawError = true
      stderr += result.stderr
    }
    if (result.exitCode === 0) sawMatch = true
  }

  return { stdout, stderr, exitCode: sawError ? 2 : sawMatch ? 0 : NO_MATCH_EXIT_CODE }
}
