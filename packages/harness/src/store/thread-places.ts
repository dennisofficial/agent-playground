import { EForkMode, toThreadId, type LinkedPullRequest, type ThreadId } from '@dltech/atlas-core'

import type { PrismaClient } from '../../prisma/generated/client'
import { ForkChainTooDeep } from './compose-thread'

export type ThreadWorktree = { path: string; branch: string }

const WORKTREE_EVENT_TYPES = ['worktree-entered', 'worktree-exited']

const PULL_REQUEST_EVENT_TYPE = 'pull-request-linked'

const REFERENCE_CHAIN_LIMIT = 8

type Reader = Pick<PrismaClient, 'event' | 'thread'>

const enteredFrom = (body: string): ThreadWorktree | null => {
  try {
    const parsed: unknown = JSON.parse(body)
    if (typeof parsed !== 'object' || parsed === null) return null

    const { path, branch } = parsed as Record<string, unknown>
    if (typeof path !== 'string' || typeof branch !== 'string') return null

    return { path, branch }
  } catch {
    return null
  }
}

const linkedFrom = (body: string): LinkedPullRequest | null => {
  try {
    const parsed: unknown = JSON.parse(body)
    if (typeof parsed !== 'object' || parsed === null) return null

    const { number, url, repo, branch } = parsed as Record<string, unknown>
    if (typeof number !== 'number') return null
    if (typeof url !== 'string' || typeof repo !== 'string' || typeof branch !== 'string') {
      return null
    }

    return { number, url, repo, branch }
  } catch {
    return null
  }
}

const pullRequestsFrom = (bodies: readonly string[]): LinkedPullRequest[] => {
  const byIdentity = new Map<string, LinkedPullRequest>()
  for (const body of bodies) {
    const linked = linkedFrom(body)
    if (linked !== null) byIdentity.set(`${linked.repo}#${linked.number}`, linked)
  }
  return [...byIdentity.values()]
}

/**
 * Where a listed thread is standing, derived from its events the way `projectDirectoryOf` derives
 * it for the screen: the latest worktree event wins, and a reference fork inherits its parent's
 * log up to the fork point. Null means home — either no worktree was ever entered, or the last
 * move was an exit.
 */
export async function threadWorktree(args: {
  prisma: Reader
  threadId: ThreadId
  upTo?: number | undefined
}): Promise<ThreadWorktree | null> {
  let threadId = args.threadId
  let upTo = args.upTo

  for (let hop = 0; hop <= REFERENCE_CHAIN_LIMIT; hop += 1) {
    const latest = await args.prisma.event.findFirst({
      where: {
        threadId,
        type: { in: [...WORKTREE_EVENT_TYPES] },
        ...(upTo === undefined ? {} : { seq: { lte: upTo } }),
      },
      orderBy: { seq: 'desc' },
      select: { type: true, body: true },
    })
    if (latest !== null) {
      return latest.type === 'worktree-entered' ? enteredFrom(latest.body) : null
    }

    const link = await args.prisma.thread.findUnique({
      where: { id: threadId },
      select: { parentThreadId: true, forkSeq: true, forkMode: true },
    })
    if (link === null || link.forkMode !== EForkMode.Reference) return null
    if (link.parentThreadId === null || link.forkSeq === null) return null

    threadId = toThreadId(link.parentThreadId)
    upTo = upTo === undefined ? link.forkSeq : Math.min(upTo, link.forkSeq)
  }

  throw new ForkChainTooDeep({ threadId: args.threadId, limit: REFERENCE_CHAIN_LIMIT })
}

/**
 * The pull requests a listed thread is linked to, folded from its events the way `pullRequestsOf`
 * folds them for the screen: oldest first, a repeat link keeping its first position while
 * refreshing its fields, and a reference fork inheriting its parent's log up to the fork point.
 * Empty means the thread never linked one.
 */
export async function threadPullRequests(args: {
  prisma: Reader
  threadId: ThreadId
  upTo?: number | undefined
}): Promise<LinkedPullRequest[]> {
  let threadId = args.threadId
  let upTo = args.upTo

  for (let hop = 0; hop <= REFERENCE_CHAIN_LIMIT; hop += 1) {
    const rows = await args.prisma.event.findMany({
      where: {
        threadId,
        type: PULL_REQUEST_EVENT_TYPE,
        ...(upTo === undefined ? {} : { seq: { lte: upTo } }),
      },
      orderBy: { seq: 'asc' },
      select: { body: true },
    })
    if (rows.length > 0) {
      return pullRequestsFrom(rows.map((row) => row.body))
    }

    const link = await args.prisma.thread.findUnique({
      where: { id: threadId },
      select: { parentThreadId: true, forkSeq: true, forkMode: true },
    })
    if (link === null || link.forkMode !== EForkMode.Reference) return []
    if (link.parentThreadId === null || link.forkSeq === null) return []

    threadId = toThreadId(link.parentThreadId)
    upTo = upTo === undefined ? link.forkSeq : Math.min(upTo, link.forkSeq)
  }

  throw new ForkChainTooDeep({ threadId: args.threadId, limit: REFERENCE_CHAIN_LIMIT })
}
