export type GitRun = { ok: boolean; stdout: string; stderr: string }

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

export const runGit = async ({
  args,
  cwd,
}: {
  args: readonly string[]
  cwd: string
}): Promise<GitRun> => {
  try {
    const git = Bun.spawn(['git', ...args], {
      cwd,
      stdout: 'pipe',
      stderr: 'pipe',
      stdin: 'ignore',
    })
    const [stdout, stderr, status] = await Promise.all([
      new Response(git.stdout).text(),
      new Response(git.stderr).text(),
      git.exited,
    ])
    return { ok: status === 0, stdout, stderr }
  } catch (error) {
    return { ok: false, stdout: '', stderr: messageOf(error) }
  }
}
