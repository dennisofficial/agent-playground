import {
  activeWorktreeOf,
  EDeed,
  EDeedRealm,
  grantsFrom,
  NO_FACTS,
  operatorUtterances,
  recentActs,
  WorkspaceFactsPort,
  type CallEvidence,
  type CommandReading,
  type Deed,
  type DeedTarget,
  type Event,
  type ToolCall,
  type WorkspaceFacts,
} from '@dltech/atlas-core'

import type { ToolLens } from './tool-lens'

export const RECENT_ACT_LIMIT = 20
export const OPERATOR_UTTERANCE_LIMIT = 6

const REWRITES_OWN_HISTORY: ReadonlySet<EDeed> = new Set([EDeed.RewriteHistory, EDeed.ForcePush])

const namesARef = ({ deed }: { deed: Deed }): boolean =>
  deed.targets.some((target) => target.realm === EDeedRealm.GitRef)

function ownBranchTargets({
  deeds,
  events,
}: {
  deeds: readonly Deed[]
  events: readonly Event[]
}): readonly DeedTarget[] {
  const rewriting = deeds.some(
    (deed) => REWRITES_OWN_HISTORY.has(deed.action) && !namesARef({ deed }),
  )
  if (!rewriting) return []

  const branch = activeWorktreeOf(events)?.branch
  return branch === undefined ? [] : [{ realm: EDeedRealm.GitRef, value: branch }]
}

export function factRequestFor({
  deeds,
  events,
}: {
  deeds: readonly Deed[]
  events: readonly Event[]
}): { realms: readonly EDeedRealm[]; targets: readonly DeedTarget[] } {
  const named = deeds.flatMap((deed) => [
    ...deed.targets,
    ...(deed.cwd === undefined ? [] : [{ realm: EDeedRealm.Path, value: deed.cwd }]),
  ])
  const targets = [...named, ...ownBranchTargets({ deeds, events })]

  const seen = new Map<string, DeedTarget>()
  for (const target of targets) seen.set(`${target.realm}:${target.value}`, target)

  const distinct = [...seen.values()]
  return { realms: [...new Set(distinct.map((target) => target.realm))], targets: distinct }
}

async function factsOrNone({
  facts,
  deeds,
  events,
  projectDirectory,
  launchDirectory,
}: {
  facts: WorkspaceFactsPort
  deeds: readonly Deed[]
  events: readonly Event[]
  projectDirectory: string
  launchDirectory: string
}): Promise<WorkspaceFacts> {
  try {
    return await facts.factsFor({
      ...factRequestFor({ deeds, events }),
      projectDirectory,
      launchDirectory,
    })
  } catch {
    return NO_FACTS
  }
}

export async function collectEvidence({
  call,
  deeds,
  reading,
  events,
  projectDirectory,
  launchDirectory,
  facts,
  lens,
}: {
  call: ToolCall
  deeds: readonly Deed[]
  reading: CommandReading | undefined
  events: readonly Event[]
  projectDirectory: string
  launchDirectory: string
  facts: WorkspaceFactsPort
  lens: ToolLens
}): Promise<CallEvidence> {
  return {
    deeds,
    toolName: call.name,
    effect: call.effect,
    threadId: call.threadId,
    reading,
    facts: await factsOrNone({ facts, deeds, events, projectDirectory, launchDirectory }),
    recent: recentActs({
      events,
      limit: RECENT_ACT_LIMIT,
      lens: lens.actLensFor({ projectDirectory }),
    }),
    said: operatorUtterances({ events, limit: OPERATOR_UTTERANCE_LIMIT }),
    grants: grantsFrom(events),
  }
}
