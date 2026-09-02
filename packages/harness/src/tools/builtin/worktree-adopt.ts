import {
  behindUpstream,
  inspectWorktree,
  upstreamOf,
  type Worktree,
} from '../../workspace/worktrees'
import {
  canonicalPath,
  hideWorktreeHome,
  isUnder,
  worktreeAt,
  type RepositoryView,
} from './worktree-support'

export type AdoptedWorktree = {
  path: string
  branch: string
  base: string | undefined
  report: string
}

export type AdoptOutcome = { ok: true; adopted: AdoptedWorktree } | { ok: false; reason: string }

function refusalFor({
  target,
  view,
}: {
  target: Worktree
  view: RepositoryView
}): string | undefined {
  if (target.isMain) {
    return `${target.path} is the main checkout of the repository, not a worktree of it. exit_worktree returns the session there; there is nothing to enter.`
  }
  if (target.isBare) {
    return `the worktree at ${target.path} is bare, so it has no working tree to run in`
  }
  if (target.isPrunable) {
    const reason = target.prunableReason ?? 'git did not say why'
    return `git considers the worktree at ${target.path} prunable (${reason}), so it is not a checkout the session can work in. Tell the developer, and let them repair it or run git worktree prune from ${view.root}.`
  }
  if (target.isDetached || target.branch === undefined) {
    return `the worktree at ${target.path} has a detached HEAD, so there is no branch to work on`
  }
  return undefined
}

function stateLine({
  changedCount,
  unpushedCommits,
  behind,
  upstream,
}: {
  changedCount: number
  unpushedCommits: number
  behind: number | undefined
  upstream: string | undefined
}): string {
  const parts = [
    changedCount === 0
      ? 'no uncommitted changes'
      : `${changedCount} uncommitted ${changedCount === 1 ? 'file' : 'files'}`,
  ]

  if (upstream === undefined) {
    parts.push('and no upstream branch, so nothing to compare against')
    return `It holds ${parts.join(' ')}.`
  }

  parts.push(`and, against ${upstream}, ${unpushedCommits} ahead`)
  if (behind !== undefined) parts.push(`and ${behind} behind`)
  return `It holds ${parts.join(' ')}.`
}

export async function adoptWorktree(args: {
  view: RepositoryView
  path: string
  cwd: string
  worktreeHome: string
}): Promise<AdoptOutcome> {
  const path = await canonicalPath({ base: args.cwd, path: args.path })
  const target = worktreeAt({ view: args.view, path })
  if (target === undefined) {
    const known = args.view.worktrees.map((worktree) => worktree.path).join(', ')
    const named = path === args.path ? path : `${args.path}, which is ${path},`
    return {
      ok: false,
      reason: `git does not list ${named} as a worktree of the repository at ${args.view.root}. It lists: ${known}`,
    }
  }

  const refusal = refusalFor({ target, view: args.view })
  if (refusal !== undefined) return { ok: false, reason: refusal }

  const branch = target.branch ?? ''
  if (isUnder({ directory: args.worktreeHome, path: target.path })) {
    await hideWorktreeHome({ home: args.worktreeHome })
  }

  const upstream = await upstreamOf({ cwd: target.path })
  const [inspection, behind] = await Promise.all([
    inspectWorktree({ cwd: target.path }),
    behindUpstream({ cwd: target.path }),
  ])

  const notes = [
    stateLine({
      changedCount: inspection.changedCount,
      unpushedCommits: inspection.unpushedCommits,
      behind,
      upstream,
    }),
    ...(target.isLocked
      ? [`git has it locked (${target.lockedReason ?? 'no reason given'}), so it cannot be pruned.`]
      : []),
  ]

  return {
    ok: true,
    adopted: { path: target.path, branch, base: upstream, report: notes.join(' ') },
  }
}
