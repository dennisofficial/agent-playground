import { realpath } from 'node:fs/promises'

import { runGit, type GitRun } from './run-git'
import { parseStatusPorcelain, parseWorktreePorcelain, type Worktree } from './worktrees-parse'

export type { Worktree } from './worktrees-parse'

const MESSAGE_LIMIT = 400
const CHANGED_PATH_SAMPLE = 5
const ORIGIN = 'origin'
const ORIGIN_PREFIX = `${ORIGIN}/`
const CANDIDATE_BRANCHES = ['main', 'master'] as const

export enum EWorktreeAddFailure {
  BranchExists = 'branch-exists',
  PathExists = 'path-exists',
  UnknownBase = 'unknown-base',
  NotARepo = 'not-a-repo',
  GitFailed = 'git-failed',
}

export enum EDefaultBranchSource {
  OriginHead = 'origin-head',
  OriginBranch = 'origin-branch',
  LocalBranch = 'local-branch',
}

export type StepOutcome = { ok: true } | { ok: false; message: string }

export type WorktreeListing =
  { ok: true; worktrees: readonly Worktree[] } | { ok: false; message: string }

export type DefaultBranchResult =
  { ok: true; branch: string; source: EDefaultBranchSource } | { ok: false; message: string }

export type WorktreeAddResult =
  | { ok: true; path: string; branch: string }
  | { ok: false; failure: EWorktreeAddFailure; message: string }

export type WorktreeInspection = {
  isClean: boolean
  changedPaths: readonly string[]
  changedCount: number
  unpushedCommits: number
  comparedAgainst: string | undefined
}

export type WorktreeRemoval = {
  worktreeRemoved: StepOutcome
  branchDeleted: StepOutcome | undefined
}

const readable = (text: string): string => {
  const joined = text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .join('; ')
  return joined.length > MESSAGE_LIMIT ? `${joined.slice(0, MESSAGE_LIMIT)}…` : joined
}

const canonical = async (path: string): Promise<string> => {
  try {
    return await realpath(path)
  } catch {
    return path
  }
}

const outcomeOf = (run: GitRun): StepOutcome =>
  run.ok ? { ok: true } : { ok: false, message: readable(run.stderr) }

export async function listWorktrees({ cwd }: { cwd: string }): Promise<WorktreeListing> {
  const run = await runGit({ args: ['worktree', 'list', '--porcelain'], cwd })
  if (!run.ok) return { ok: false, message: readable(run.stderr) }

  const parsed = parseWorktreePorcelain({ output: run.stdout })
  const worktrees = await Promise.all(
    parsed.map(async (worktree) => ({ ...worktree, path: await canonical(worktree.path) })),
  )

  return { ok: true, worktrees }
}

const resolves = async ({ cwd, ref }: { cwd: string; ref: string }): Promise<boolean> => {
  const run = await runGit({ args: ['rev-parse', '--verify', '--quiet', ref], cwd })
  return run.ok && run.stdout.trim().length > 0
}

export async function defaultBranch({ cwd }: { cwd: string }): Promise<DefaultBranchResult> {
  const head = await runGit({
    args: ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'],
    cwd,
  })
  const named = head.stdout.trim()
  if (head.ok && named.length > 0) {
    const branch = named.startsWith(ORIGIN_PREFIX) ? named.slice(ORIGIN_PREFIX.length) : named
    return { ok: true, branch, source: EDefaultBranchSource.OriginHead }
  }

  for (const branch of CANDIDATE_BRANCHES) {
    if (await resolves({ cwd, ref: `${ORIGIN_PREFIX}${branch}` })) {
      return { ok: true, branch, source: EDefaultBranchSource.OriginBranch }
    }
  }

  for (const branch of CANDIDATE_BRANCHES) {
    if (await resolves({ cwd, ref: `refs/heads/${branch}` })) {
      return { ok: true, branch, source: EDefaultBranchSource.LocalBranch }
    }
  }

  return {
    ok: false,
    message:
      'could not determine a default branch: no origin/HEAD, origin/main, origin/master, main or master',
  }
}

const addFailureFrom = (stderr: string): EWorktreeAddFailure => {
  const text = stderr.toLowerCase()
  if (text.includes('branch named')) return EWorktreeAddFailure.BranchExists
  if (text.includes('is already checked out')) return EWorktreeAddFailure.BranchExists
  if (
    text.includes('invalid reference') ||
    text.includes('not a valid object name') ||
    text.includes('unknown revision')
  ) {
    return EWorktreeAddFailure.UnknownBase
  }
  if (text.includes('already exists') || text.includes('already used by worktree')) {
    return EWorktreeAddFailure.PathExists
  }
  if (text.includes('not a git repository')) return EWorktreeAddFailure.NotARepo
  return EWorktreeAddFailure.GitFailed
}

export async function addWorktree({
  cwd,
  path,
  branch,
  base,
}: {
  cwd: string
  path: string
  branch: string
  base: string
}): Promise<WorktreeAddResult> {
  const run = await runGit({ args: ['worktree', 'add', path, '-b', branch, base], cwd })
  if (!run.ok) {
    return { ok: false, failure: addFailureFrom(run.stderr), message: readable(run.stderr) }
  }

  return { ok: true, path: await canonical(path), branch }
}

export async function fetchOrigin({ cwd }: { cwd: string }): Promise<StepOutcome> {
  return outcomeOf(await runGit({ args: ['fetch', ORIGIN], cwd }))
}

export const upstreamOf = async ({ cwd }: { cwd: string }): Promise<string | undefined> => {
  const run = await runGit({
    args: ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'],
    cwd,
  })
  const name = run.stdout.trim()
  return run.ok && name.length > 0 ? name : undefined
}

export const behindUpstream = async ({ cwd }: { cwd: string }): Promise<number | undefined> => {
  const upstream = await upstreamOf({ cwd })
  if (upstream === undefined) return undefined

  const run = await runGit({ args: ['rev-list', '--count', `HEAD..${upstream}`], cwd })
  if (!run.ok) return undefined
  const count = Number.parseInt(run.stdout.trim(), 10)
  return Number.isNaN(count) ? undefined : count
}

const commitsAhead = async ({
  cwd,
  ref,
}: {
  cwd: string
  ref: string
}): Promise<number | undefined> => {
  const run = await runGit({ args: ['rev-list', '--count', `${ref}..HEAD`], cwd })
  if (!run.ok) return undefined
  const count = Number.parseInt(run.stdout.trim(), 10)
  return Number.isNaN(count) ? undefined : count
}

const aheadOfEither = async ({
  cwd,
  base,
}: {
  cwd: string
  base: string | undefined
}): Promise<{ count: number; comparedAgainst: string | undefined }> => {
  const upstream = await upstreamOf({ cwd })
  if (upstream !== undefined) {
    const count = await commitsAhead({ cwd, ref: upstream })
    if (count !== undefined) return { count, comparedAgainst: upstream }
  }
  if (base === undefined) return { count: 0, comparedAgainst: undefined }

  const count = await commitsAhead({ cwd, ref: base })
  return count === undefined
    ? { count: 0, comparedAgainst: undefined }
    : { count, comparedAgainst: base }
}

export async function inspectWorktree({
  cwd,
  base,
}: {
  cwd: string
  base?: string | undefined
}): Promise<WorktreeInspection> {
  const status = await runGit({ args: ['status', '--porcelain'], cwd })
  const changed = status.ok ? parseStatusPorcelain({ output: status.stdout }) : []
  const ahead = await aheadOfEither({ cwd, base })

  return {
    isClean: changed.length === 0 && ahead.count === 0,
    changedPaths: changed.slice(0, CHANGED_PATH_SAMPLE),
    changedCount: changed.length,
    unpushedCommits: ahead.count,
    comparedAgainst: ahead.comparedAgainst,
  }
}

export async function removeWorktree({
  cwd,
  path,
  branch,
  force,
}: {
  cwd: string
  path: string
  branch?: string | undefined
  force: boolean
}): Promise<WorktreeRemoval> {
  const args = force ? ['worktree', 'remove', '--force', path] : ['worktree', 'remove', path]
  const removed = outcomeOf(await runGit({ args, cwd }))
  if (!removed.ok) return { worktreeRemoved: removed, branchDeleted: undefined }
  if (branch === undefined) return { worktreeRemoved: removed, branchDeleted: undefined }

  const deleted = outcomeOf(await runGit({ args: ['branch', '-D', branch], cwd }))
  return { worktreeRemoved: removed, branchDeleted: deleted }
}

export async function lockWorktree({
  cwd,
  path,
  reason,
}: {
  cwd: string
  path: string
  reason: string
}): Promise<StepOutcome> {
  return outcomeOf(await runGit({ args: ['worktree', 'lock', '--reason', reason, path], cwd }))
}

export async function unlockWorktree({
  cwd,
  path,
}: {
  cwd: string
  path: string
}): Promise<StepOutcome> {
  return outcomeOf(await runGit({ args: ['worktree', 'unlock', path], cwd }))
}

export async function pruneWorktrees({ cwd }: { cwd: string }): Promise<StepOutcome> {
  return outcomeOf(await runGit({ args: ['worktree', 'prune'], cwd }))
}
