import { isUnderPath } from '@dltech/atlas-core'

import type { GitRun } from '../workspace/run-git'
import {
  parseStatusPorcelain,
  parseWorktreePorcelain,
  type Worktree,
} from '../workspace/worktrees-parse'

export type GitRunner = (args: { args: readonly string[]; cwd: string }) => Promise<GitRun>

export type Dirtiness = {
  changedPaths: readonly string[]
  changedCount: number
  unpushedCommits: number | undefined
}

const countOf = (run: GitRun): number | undefined => {
  if (!run.ok) return undefined
  const count = Number.parseInt(run.stdout.trim(), 10)
  return Number.isNaN(count) ? undefined : count
}

export async function worktreeListing(args: {
  runGit: GitRunner
  canonicalPath: (path: string) => Promise<string>
  cwd: string
}): Promise<readonly Worktree[]> {
  const run = await args.runGit({ args: ['worktree', 'list', '--porcelain'], cwd: args.cwd })
  if (!run.ok) return []

  return await Promise.all(
    parseWorktreePorcelain({ output: run.stdout }).map(async (worktree) => ({
      ...worktree,
      path: await args.canonicalPath(worktree.path),
    })),
  )
}

async function unpushedAt(args: { runGit: GitRunner; cwd: string }): Promise<number | undefined> {
  const upstream = await args.runGit({
    args: ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'],
    cwd: args.cwd,
  })
  const named = upstream.stdout.trim()
  if (!upstream.ok || named.length === 0) return undefined

  return countOf(
    await args.runGit({ args: ['rev-list', '--count', `${named}..HEAD`], cwd: args.cwd }),
  )
}

export async function dirtinessAt(args: {
  runGit: GitRunner
  cwd: string
}): Promise<Dirtiness | undefined> {
  const status = await args.runGit({ args: ['status', '--porcelain'], cwd: args.cwd })
  if (!status.ok) return undefined

  const changedPaths = parseStatusPorcelain({ output: status.stdout })

  return {
    changedPaths,
    changedCount: changedPaths.length,
    unpushedCommits: await unpushedAt(args),
  }
}

export async function refIsOnRemote(args: {
  runGit: GitRunner
  cwd: string
  ref: string
}): Promise<boolean> {
  const run = await args.runGit({ args: ['branch', '-r', '--contains', args.ref], cwd: args.cwd })
  if (!run.ok) return true

  return run.stdout.split('\n').some((line) => line.trim().length > 0)
}

export function containingWorktree(args: {
  listing: readonly Worktree[]
  path: string
}): Worktree | undefined {
  let deepest: Worktree | undefined
  for (const worktree of args.listing) {
    if (!isUnderPath({ directory: worktree.path, path: args.path })) continue
    if (deepest === undefined || worktree.path.length > deepest.path.length) deepest = worktree
  }

  return deepest
}
