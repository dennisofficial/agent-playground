import { realpath } from 'node:fs/promises'

import {
  EDeedRealm,
  NO_FACTS,
  resolveAgainst,
  WorkspaceFactsPort,
  type FactRequest,
  type DeedTarget,
  type FactWarming,
  type RefFact,
  type WorkspaceFacts,
  type WorktreeFact,
  type WorktreeLockIdentity,
} from '@dltech/atlas-core'

import { holderIsLive, ownIdentity } from '../workspace/process-identity'
import { runGit } from '../workspace/run-git'
import type { Worktree } from '../workspace/worktrees-parse'
import { EFactScope, FactsCache, type FactSlots } from './facts-cache'
import {
  containingWorktree,
  dirtinessAt,
  refIsOnRemote,
  worktreeListing,
  type Dirtiness,
  type GitRunner,
} from './git-facts'
import { seatOf, type Seat } from './occupancy'

export const REGENERABLE_PATHS: readonly string[] = [
  'node_modules',
  'dist',
  'build',
  'out',
  'coverage',
  '.next',
  '.turbo',
  '.cache',
  '.parcel-cache',
  'target',
]

export type WorkspaceFactsDeps = {
  runGit?: GitRunner | undefined
  canonicalPath?: ((path: string) => Promise<string>) | undefined
  ownIdentity?: (() => Promise<WorktreeLockIdentity>) | undefined
  holderIsLive?: ((identity: WorktreeLockIdentity) => Promise<boolean>) | undefined
  now?: (() => number) | undefined
  regenerablePaths?: readonly string[] | undefined
  briefTtlMs?: number | undefined
}

const canonicalOf = async (path: string): Promise<string> => {
  try {
    return await realpath(path)
  } catch {
    return path
  }
}

const uniquely = <TValue>(values: readonly TValue[]): readonly TValue[] => [...new Set(values)]

const valuesFor = (args: {
  targets: readonly DeedTarget[]
  realm: EDeedRealm
  base: string
}): readonly string[] =>
  uniquely(
    args.targets
      .filter((target) => target.realm === args.realm)
      .map((target) => resolveAgainst({ base: args.base, path: target.value })),
  )

export class GitWorkspaceFacts extends WorkspaceFactsPort {
  private readonly runGit: GitRunner
  private readonly canonicalPath: (path: string) => Promise<string>
  private readonly ownIdentity: () => Promise<WorktreeLockIdentity>
  private readonly holderIsLive: (identity: WorktreeLockIdentity) => Promise<boolean>
  private readonly regenerablePaths: readonly string[]
  private readonly cache: FactsCache
  private readonly membership: FactSlots<readonly Worktree[]>
  private readonly seats: FactSlots<Seat>
  private readonly dirtiness: FactSlots<Dirtiness | undefined>
  private readonly remoteRefs: FactSlots<boolean>

  constructor(deps: WorkspaceFactsDeps = {}) {
    super()
    this.runGit = deps.runGit ?? runGit
    this.canonicalPath = deps.canonicalPath ?? canonicalOf
    this.ownIdentity = deps.ownIdentity ?? ownIdentity
    this.holderIsLive = deps.holderIsLive ?? holderIsLive
    this.regenerablePaths = deps.regenerablePaths ?? REGENERABLE_PATHS
    this.cache = new FactsCache({
      now: deps.now ?? (() => Date.now()),
      briefTtlMs: deps.briefTtlMs,
    })
    this.membership = this.cache.slots({ scope: EFactScope.Session })
    this.seats = this.cache.slots({ scope: EFactScope.Turn })
    this.dirtiness = this.cache.slots({ scope: EFactScope.Brief })
    this.remoteRefs = this.cache.slots({ scope: EFactScope.Turn })
  }

  async factsFor(request: FactRequest): Promise<WorkspaceFacts> {
    try {
      return await this.collect(request)
    } catch {
      return NO_FACTS
    }
  }

  prewarm(warming: FactWarming): void {
    this.cache.expire({ scope: EFactScope.Turn })
    void this.factsFor({
      realms: [EDeedRealm.Path, EDeedRealm.GitWorktree],
      targets: [],
      ...warming,
    })
  }

  invalidate(): void {
    this.cache.expireAll()
  }

  private async collect(request: FactRequest): Promise<WorkspaceFacts> {
    const { realms, targets, projectDirectory, launchDirectory } = request
    const listing = await this.membership.read({
      key: projectDirectory,
      collect: () =>
        worktreeListing({
          runGit: this.runGit,
          canonicalPath: this.canonicalPath,
          cwd: projectDirectory,
        }),
    })

    const repo = listing.find((worktree) => worktree.isMain)?.path
    const bare: WorkspaceFacts = {
      projectDirectory,
      launchDirectory,
      repo,
      worktrees: [],
      refs: [],
      ownChangedPaths: [],
      regenerablePaths: this.regenerablePaths,
      gatheredFor: [],
    }
    if (repo === undefined) return bare

    const paths = valuesFor({ targets, realm: EDeedRealm.Path, base: projectDirectory })
    const gatheredFor = this.widen({ realms, listing, paths })

    const named = [
      ...paths,
      ...valuesFor({ targets, realm: EDeedRealm.GitWorktree, base: projectDirectory }),
    ]
    if (!gatheredFor.includes(EDeedRealm.GitWorktree)) {
      const refs = await this.refFacts({ repo, listing, targets, gatheredFor })
      return { ...bare, gatheredFor, refs }
    }

    const ourPath = containingWorktree({ listing, path: projectDirectory })?.path
    const relevant = this.relevantWorktrees({ listing, named, ourPath })

    return {
      ...bare,
      gatheredFor,
      worktrees: await this.worktreeFacts({ listing, relevant, ourPath }),
      refs: await this.refFacts({ repo, listing, targets, gatheredFor }),
      ownChangedPaths: ourPath === undefined ? [] : await this.ownChanges({ path: ourPath }),
    }
  }

  private widen(args: {
    realms: readonly EDeedRealm[]
    listing: readonly Worktree[]
    paths: readonly string[]
  }): readonly EDeedRealm[] {
    const { realms, listing, paths } = args
    if (realms.includes(EDeedRealm.GitWorktree)) return uniquely(realms)
    if (!realms.includes(EDeedRealm.Path)) return uniquely(realms)

    const inside = paths.some((path) => containingWorktree({ listing, path }) !== undefined)
    return inside ? uniquely([...realms, EDeedRealm.GitWorktree]) : uniquely(realms)
  }

  private relevantWorktrees(args: {
    listing: readonly Worktree[]
    named: readonly string[]
    ourPath: string | undefined
  }): ReadonlySet<string> {
    const relevant = new Set<string>(args.ourPath === undefined ? [] : [args.ourPath])
    for (const path of args.named) {
      const found = containingWorktree({ listing: args.listing, path })
      if (found !== undefined) relevant.add(found.path)
    }

    return relevant
  }

  private async worktreeFacts(args: {
    listing: readonly Worktree[]
    relevant: ReadonlySet<string>
    ourPath: string | undefined
  }): Promise<readonly WorktreeFact[]> {
    return await Promise.all(
      args.listing.map(async (worktree) => {
        const seat = await this.seats.read({
          key: worktree.path,
          collect: () =>
            seatOf({
              worktree,
              ourPath: args.ourPath,
              ownIdentity: this.ownIdentity,
              holderIsLive: this.holderIsLive,
            }),
        })
        const dirt = args.relevant.has(worktree.path)
          ? await this.dirtOf({ path: worktree.path })
          : undefined

        return {
          path: worktree.path,
          branch: worktree.branch,
          isMain: worktree.isMain,
          occupancy: seat.occupancy,
          heldBy: seat.heldBy,
          changedCount: dirt?.changedCount,
          unpushedCommits: dirt?.unpushedCommits,
        }
      }),
    )
  }

  private async dirtOf({ path }: { path: string }): Promise<Dirtiness | undefined> {
    return await this.dirtiness.read({
      key: path,
      collect: () => dirtinessAt({ runGit: this.runGit, cwd: path }),
    })
  }

  private async ownChanges({ path }: { path: string }): Promise<readonly string[]> {
    return (await this.dirtOf({ path }))?.changedPaths ?? []
  }

  private async refFacts(args: {
    repo: string
    listing: readonly Worktree[]
    targets: readonly DeedTarget[]
    gatheredFor: readonly EDeedRealm[]
  }): Promise<readonly RefFact[]> {
    if (!args.gatheredFor.includes(EDeedRealm.GitRef)) return []

    const refs = uniquely(
      args.targets
        .filter((target) => target.realm === EDeedRealm.GitRef)
        .map((target) => target.value),
    )

    return await Promise.all(
      refs.map(async (ref) => ({
        ref,
        onRemote: await this.remoteRefs.read({
          key: ref,
          collect: () => refIsOnRemote({ runGit: this.runGit, cwd: args.repo, ref }),
        }),
        checkedOutAt: args.listing
          .filter((worktree) => worktree.branch === ref)
          .map((worktree) => worktree.path),
      })),
    )
  }
}
