import { toCallId, toThreadId } from '../../../events/ids'
import {
  EContentAccess,
  EPathForm,
  EPathPresence,
  EToolEffect,
  type ToolCall,
} from '../../../tools/tool'
import { readCommand } from '../command/read-command'
import { EPathDeclaration, deedsOf } from '../deed-of'
import type { CallEvidence, RecentAct } from '../evidence'
import { EOccupancy, type RefFact, type WorkspaceFacts, type WorktreeFact } from '../facts'
import type { Grant } from '../grant'
import { signalsFor } from '../signals'
import { DEFAULT_CLASSIFIER_POLICY, triageOf, type ClassifierPolicy, type Triage } from '../triage'

export const REPO = '/Users/dennis/Developer/atlas'
export const OURS = `${REPO}/.claude/worktrees/eng-327-api-eslint`
export const SIBLING = `${REPO}/.claude/worktrees/eng-412-sidebar`
export const HOME = '/Users/dennis'

export const REGENERABLE: readonly string[] = [
  'node_modules',
  'dist',
  'build',
  'out',
  '.next',
  '.turbo',
  '.cache',
]

export function worktreeFact(args: {
  path: string
  branch?: string | undefined
  isMain?: boolean | undefined
  occupancy?: EOccupancy | undefined
  heldBy?: number | undefined
  changedCount?: number | undefined
  unpushedCommits?: number | undefined
}): WorktreeFact {
  return {
    path: args.path,
    branch: args.branch,
    isMain: args.isMain ?? false,
    occupancy: args.occupancy ?? EOccupancy.Unknown,
    heldBy: args.heldBy,
    changedCount: args.changedCount,
    unpushedCommits: args.unpushedCommits,
  }
}

export function factsAt(args: {
  projectDirectory: string
  worktrees?: readonly WorktreeFact[] | undefined
  refs?: readonly RefFact[] | undefined
  ownChangedPaths?: readonly string[] | undefined
}): WorkspaceFacts {
  return {
    projectDirectory: args.projectDirectory,
    launchDirectory: args.projectDirectory,
    repo: REPO,
    worktrees: args.worktrees ?? [],
    refs: args.refs ?? [],
    ownChangedPaths: args.ownChangedPaths ?? [],
    regenerablePaths: REGENERABLE,
    gatheredFor: [],
  }
}

export function onMain(args?: { changedCount?: number | undefined }): WorkspaceFacts {
  return factsAt({
    projectDirectory: REPO,
    worktrees: [
      worktreeFact({
        path: REPO,
        branch: 'main',
        isMain: true,
        occupancy: EOccupancy.Ours,
        changedCount: args?.changedCount ?? 276,
      }),
    ],
  })
}

export function inAWorktree(args?: {
  siblingChangedCount?: number | undefined
  siblingOccupancy?: EOccupancy | undefined
  siblingHeldBy?: number | undefined
  mainChangedCount?: number | undefined
  refs?: readonly RefFact[] | undefined
}): WorkspaceFacts {
  return factsAt({
    projectDirectory: OURS,
    refs: args?.refs,
    worktrees: [
      worktreeFact({
        path: REPO,
        branch: 'main',
        isMain: true,
        changedCount: args?.mainChangedCount ?? 276,
      }),
      worktreeFact({
        path: OURS,
        branch: 'dennis/eng-327-api-eslint',
        occupancy: EOccupancy.Ours,
        changedCount: 2,
      }),
      worktreeFact({
        path: SIBLING,
        branch: 'dennis/eng-412-sidebar',
        occupancy: args?.siblingOccupancy ?? EOccupancy.Unknown,
        heldBy: args?.siblingHeldBy,
        changedCount: args?.siblingChangedCount ?? 0,
      }),
    ],
  })
}

const callTo = (args: { name: string; input: unknown; effect: EToolEffect }): ToolCall => ({
  callId: toCallId('call-1'),
  name: args.name,
  input: args.input,
  effect: args.effect,
  threadId: toThreadId('thread-1'),
})

export function bashEvidence(args: {
  command: string
  facts: WorkspaceFacts
  workdir?: string | undefined
  effect?: EToolEffect | undefined
  recent?: readonly RecentAct[] | undefined
  grants?: readonly Grant[] | undefined
}): CallEvidence {
  const effect = args.effect ?? EToolEffect.Destructive
  const projectDirectory = args.facts.projectDirectory
  const reading = readCommand({ command: args.command, workdir: args.workdir, projectDirectory })

  return {
    deeds: deedsOf({
      call: callTo({ name: 'bash', input: { command: args.command }, effect }),
      declaration: { kind: EPathDeclaration.Declared, fields: [] },
      reading,
      projectDirectory,
    }),
    toolName: 'bash',
    effect,
    threadId: toThreadId('thread-1'),
    reading,
    facts: args.facts,
    recent: args.recent ?? [],
    said: [],
    grants: args.grants ?? [],
  }
}

export function writeEvidence(args: {
  path: string
  facts: WorkspaceFacts
  recent?: readonly RecentAct[] | undefined
  grants?: readonly Grant[] | undefined
}): CallEvidence {
  const call = callTo({
    name: 'write',
    input: { path: args.path, content: 'x' },
    effect: EToolEffect.Write,
  })

  return {
    deeds: deedsOf({
      call,
      declaration: {
        kind: EPathDeclaration.Declared,
        fields: [
          {
            field: 'path',
            presence: EPathPresence.Required,
            form: EPathForm.Absolute,
            content: EContentAccess.Overwrites,
          },
        ],
      },
      reading: undefined,
      projectDirectory: args.facts.projectDirectory,
    }),
    toolName: 'write',
    effect: EToolEffect.Write,
    threadId: toThreadId('thread-1'),
    reading: undefined,
    facts: args.facts,
    recent: args.recent ?? [],
    said: [],
    grants: args.grants ?? [],
  }
}

export function recentAct(args: {
  name: string
  ingestedUntrustedContent?: boolean | undefined
  readSecretShapedPath?: boolean | undefined
}): RecentAct {
  return {
    name: args.name,
    effect: EToolEffect.Read,
    deeds: [],
    ingestedUntrustedContent: args.ingestedUntrustedContent ?? false,
    readSecretShapedPath: args.readSecretShapedPath ?? false,
  }
}

export function triageFor(args: {
  evidence: CallEvidence
  policy?: ClassifierPolicy | undefined
  asksSoFar?: number | undefined
}): Triage {
  return triageOf({
    evidence: args.evidence,
    signals: signalsFor({ evidence: args.evidence }),
    policy: args.policy ?? DEFAULT_CLASSIFIER_POLICY,
    asksSoFar: args.asksSoFar ?? 0,
  })
}
