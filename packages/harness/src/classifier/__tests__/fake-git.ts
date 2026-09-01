import type { GitRunner } from '../git-facts'

export type GitCall = { args: readonly string[]; cwd: string }

export type GitReply = { ok?: boolean; stdout?: string; stderr?: string }

export type FakeGit = {
  runGit: GitRunner
  calls: readonly GitCall[]
  timesCalled: (args: { verb: string; cwd?: string }) => number
}

export const REPO = '/repo'
export const SIBLING = '/repo/.claude/worktrees/eng-412-sidebar'
export const OURS = '/repo/.claude/worktrees/eng-500-facts'

export const OUR_IDENTITY = { pid: 4001, start: 'Mon Jan  1 00:00:00 2035' }

export const lockToken = (args: { label: string; pid: number; start: string }): string =>
  `atlas ${args.label} (pid ${args.pid} start ${args.start})`

export const porcelainOf = (
  entries: readonly { path: string; branch?: string; locked?: string | true }[],
): string =>
  entries
    .map((entry) => {
      const lines = [`worktree ${entry.path}`, 'HEAD 0000000000000000000000000000000000000000']
      if (entry.branch !== undefined) lines.push(`branch refs/heads/${entry.branch}`)
      if (entry.locked === true) lines.push('locked')
      if (typeof entry.locked === 'string') lines.push(`locked ${entry.locked}`)
      return `${lines.join('\n')}\n`
    })
    .join('\n')

export const statusOf = (paths: readonly string[]): string =>
  paths.map((path) => ` M ${path}`).join('\n')

export function fakeGit(answer: (call: GitCall) => GitReply | undefined): FakeGit {
  const calls: GitCall[] = []

  const runGit: GitRunner = async (call) => {
    calls.push(call)
    const reply = answer(call)
    if (reply === undefined) return { ok: false, stdout: '', stderr: 'no fake answer' }

    return { ok: reply.ok ?? true, stdout: reply.stdout ?? '', stderr: reply.stderr ?? '' }
  }

  const timesCalled = ({ verb, cwd }: { verb: string; cwd?: string }): number =>
    calls.filter(
      (call) => call.args.join(' ').startsWith(verb) && (cwd === undefined || call.cwd === cwd),
    ).length

  return { runGit, calls, timesCalled }
}

export function answerFor(options: {
  listing: string
  changed?: Record<string, readonly string[]>
  remote?: Record<string, string>
}): (call: GitCall) => GitReply | undefined {
  return (call) => {
    const line = call.args.join(' ')
    if (line === 'worktree list --porcelain') return { stdout: options.listing }
    if (line === 'status --porcelain') {
      return { stdout: statusOf(options.changed?.[call.cwd] ?? []) }
    }
    if (line.startsWith('rev-parse --abbrev-ref')) return { stdout: 'origin/head' }
    if (line.startsWith('rev-list --count')) return { stdout: '2' }
    if (line.startsWith('branch -r --contains')) {
      const ref = call.args[call.args.length - 1] ?? ''
      return { stdout: options.remote?.[ref] ?? '' }
    }

    return undefined
  }
}
