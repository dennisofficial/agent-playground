import type { EDeedRealm } from './deed'

export enum EOccupancy {
  Ours = 'ours',
  LiveOther = 'live-other',
  Unknown = 'unknown',
}

export type WorktreeFact = {
  path: string
  branch: string | undefined
  isMain: boolean
  occupancy: EOccupancy
  heldBy: number | undefined
  changedCount: number | undefined
  unpushedCommits: number | undefined
}

export type RefFact = { ref: string; onRemote: boolean; checkedOutAt: readonly string[] }

export type WorkspaceFacts = {
  projectDirectory: string
  launchDirectory: string
  repo: string | undefined
  worktrees: readonly WorktreeFact[]
  refs: readonly RefFact[]
  ownChangedPaths: readonly string[]
  regenerablePaths: readonly string[]
  gatheredFor: readonly EDeedRealm[]
}

export const NO_FACTS: WorkspaceFacts = {
  projectDirectory: '',
  launchDirectory: '',
  repo: undefined,
  worktrees: [],
  refs: [],
  ownChangedPaths: [],
  regenerablePaths: [],
  gatheredFor: [],
}
