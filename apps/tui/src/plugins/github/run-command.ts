import { stat } from 'node:fs/promises'

export enum ESpawnFailure {
  BinaryMissing = 'binary-missing',
  DirectoryUnusable = 'directory-unusable',
  Other = 'other',
}

export type CommandRun = {
  code: number
  stdout: string
  stderr: string
  failure: ESpawnFailure | null
}

export type CommandRunner = (args: {
  argv: readonly string[]
  cwd: string
  timeoutMs: number
}) => Promise<CommandRun>

export const SPAWN_FAILED = -1

const NON_INTERACTIVE_ENV = {
  GH_PAGER: 'cat',
  GH_NO_UPDATE_NOTIFIER: '1',
  NO_COLOR: '1',
  CLICOLOR: '0',
} as const

const NOT_FOUND = 'ENOENT'

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

const codeOf = (error: unknown): string | null => {
  if (!(error instanceof Error) || !('code' in error)) return null

  const code = error.code
  return typeof code === 'string' ? code : null
}

const isDirectory = async (path: string): Promise<boolean> => {
  try {
    return (await stat(path)).isDirectory()
  } catch {
    return false
  }
}

/**
 * Bun raises ENOENT both for a binary that is not on PATH and for a working directory that no
 * longer exists — `posix_spawn` reports the same errno for the chdir — so the code alone cannot
 * tell "gh is not installed" from "this worktree was deleted". The directory is a fact we can check
 * rather than infer, so it is checked, and only a spawn that fails with a usable directory is
 * allowed to mean the binary is missing.
 */
const failureOf = async (args: { error: unknown; cwd: string }): Promise<ESpawnFailure> => {
  if (!(await isDirectory(args.cwd))) return ESpawnFailure.DirectoryUnusable
  if (codeOf(args.error) === NOT_FOUND) return ESpawnFailure.BinaryMissing

  return ESpawnFailure.Other
}

/**
 * The timeout is a `setTimeout` that kills the child rather than `Bun.spawn`'s own option, so the
 * behaviour does not move with the Bun version under it.
 */
export const spawnCommand: CommandRunner = async ({ argv, cwd, timeoutMs }) => {
  try {
    const child = Bun.spawn([...argv], {
      cwd,
      env: { ...process.env, ...NON_INTERACTIVE_ENV },
      stdout: 'pipe',
      stderr: 'pipe',
      stdin: 'ignore',
    })

    const timer = setTimeout(() => child.kill(), timeoutMs)
    timer.unref?.()

    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ])
    clearTimeout(timer)

    return { code, stdout, stderr, failure: null }
  } catch (error) {
    return {
      code: SPAWN_FAILED,
      stdout: '',
      stderr: messageOf(error),
      failure: await failureOf({ error, cwd }),
    }
  }
}
