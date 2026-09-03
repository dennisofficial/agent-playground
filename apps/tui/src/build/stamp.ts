export type SourceState = {
  readonly head: string
  readonly diff: string
}

export function sourceStampOf(state: SourceState): string {
  return new Bun.CryptoHasher('sha256').update(`${state.head}\n${state.diff}`).digest('hex')
}

const git = async (repo: string, args: readonly string[]): Promise<string | null> => {
  const proc = Bun.spawn(['git', '-C', repo, ...args], { stdout: 'pipe', stderr: 'ignore' })
  const text = await new Response(proc.stdout).text()
  return (await proc.exited) === 0 ? text : null
}

export async function probeSourceState(args: { repo: string }): Promise<SourceState | null> {
  const head = await git(args.repo, ['rev-parse', 'HEAD'])
  if (head === null) return null

  const diff = await git(args.repo, ['diff', '--no-color', '--no-ext-diff', 'HEAD'])
  if (diff === null) return null

  return { head: head.trim(), diff }
}

export async function sourceStateStamp(args: { repo: string }): Promise<string | null> {
  const state = await probeSourceState(args)
  return state === null ? null : sourceStampOf(state)
}

export async function repoRootOf(cwd: string): Promise<string | null> {
  const root = await git(cwd, ['rev-parse', '--show-toplevel'])
  return root === null ? null : root.trim()
}
