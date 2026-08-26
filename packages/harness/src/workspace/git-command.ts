export type GitOutcome = { stdout: string; stderr: string; exitCode: number }

export type GitCommand = {
  cwd: string
  args: readonly string[]
  indexFile?: string | undefined
  stdin?: string | undefined
}

/**
 * GIT_INDEX_FILE names the index a command reads and writes, so every plumbing call here can be
 * aimed at a private file instead of the developer's. It is also inherited by hooks, so a git
 * process that spawned Atlas would otherwise leak its index into these calls.
 * https://git-scm.com/docs/git#Documentation/git.txt-codeGITINDEXFILEcode
 */
function environmentFor(indexFile: string | undefined): Record<string, string | undefined> {
  const inherited = { ...Bun.env }
  if (indexFile === undefined) {
    delete inherited.GIT_INDEX_FILE
    return inherited
  }
  return { ...inherited, GIT_INDEX_FILE: indexFile }
}

export async function runGit(command: GitCommand): Promise<GitOutcome> {
  const process = Bun.spawn({
    cmd: ['git', ...command.args],
    cwd: command.cwd,
    env: environmentFor(command.indexFile),
    stdin: command.stdin === undefined ? 'ignore' : new TextEncoder().encode(command.stdin),
    stdout: 'pipe',
    stderr: 'pipe',
  })

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited,
  ])

  return { stdout, stderr, exitCode }
}

export async function runGitOrThrow(command: GitCommand): Promise<string> {
  const outcome = await runGit(command)
  if (outcome.exitCode === 0) return outcome.stdout

  const complaint = outcome.stderr.trim() === '' ? outcome.stdout.trim() : outcome.stderr.trim()
  throw new Error(`git ${command.args.join(' ')} failed with code ${outcome.exitCode}: ${complaint}`)
}
