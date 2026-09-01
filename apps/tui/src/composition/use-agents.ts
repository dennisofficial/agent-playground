import type { ThreadId } from '@dltech/atlas-core'
import type { AgentSnapshot } from '@dltech/atlas-harness'
import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react'

import { DEFAULT_CREW_CAP, foldCrew } from '../store/crew-fold'
import {
  DEFAULT_CREW_GRACE_MS,
  ECrewStanding,
  partitionCrew,
  type CrewMember,
} from '../store/crew-retirement'
import { NO_VISITS, lastVisitOf, recordDeparture, type CrewVisits } from '../store/crew-visits'
import { withCrew, type SidebarModel } from '../store/sidebar-model'
import {
  isSubagentRunning,
  subagentRows,
  subagentShowsElapsed,
  subagentWentWrong,
} from '../store/subagent-row'
import type { AtlasApp } from './compose'
import { useAgentSpend } from './use-agent-spend'
import { useTickingNow } from './use-ticking-now'

export type AgentsControl = {
  sidebar: SidebarModel
  everywhere: readonly AgentSnapshot[]
  visits: CrewVisits
  running: number
  count: number
}

/**
 * The departure is recorded by the effect's cleanup rather than by watching the next value, so a
 * child that is still open holds no reading at all and its grace clock cannot start while the
 * operator is reading it.
 */
function useCrewVisits(viewing: ThreadId | null): CrewVisits {
  const [visits, setVisits] = useState<CrewVisits>(NO_VISITS)

  useEffect(() => {
    if (viewing === null) return

    return () => {
      setVisits((held) =>
        recordDeparture({ visits: held, leaving: viewing, at: new Date().toISOString() }),
      )
    }
  }, [viewing])

  return visits
}

const crewMembersOf = (args: {
  snapshots: readonly AgentSnapshot[]
  visits: CrewVisits
}): readonly CrewMember[] =>
  args.snapshots.map((snapshot) => ({
    agentId: snapshot.agentId,
    spawnedBy: snapshot.spawnedBy,
    status: snapshot.status,
    endedAt: snapshot.endedAt ?? null,
    deliveredAt: snapshot.deliveredAt ?? null,
    lastViewedAt: lastVisitOf({ visits: args.visits, id: snapshot.agentId }),
  }))

/**
 * A grace window that nothing is watching would never elapse: the elapsed tick stops once the last
 * child settles, and the panel would hold a retired row until some unrelated event redrew it. The
 * reading is taken against the wall clock rather than the ticked one so that the answer is what
 * decides whether to keep ticking at all.
 */
const graceIsRunning = (args: {
  members: readonly CrewMember[]
  viewing: ThreadId | null
}): boolean => {
  if (args.members.length === 0) return false

  const { standings } = partitionCrew({
    crew: args.members,
    viewing: args.viewing,
    now: Date.now(),
    graceMs: DEFAULT_CREW_GRACE_MS,
  })

  for (const standing of standings.values()) {
    if (standing === ECrewStanding.Retiring) return true
  }

  return false
}

/**
 * Every state change of a child is an event the registry already announces, so the sidebar reads
 * the held listing rather than polling one out of it the way a background shell has to be polled.
 *
 * The scoped listing is what a conversation may see; the unscoped one exists for the exit guard
 * alone, because quitting stops every child whoever spawned it.
 */
export function useAgents({
  app,
  threadId,
  sidebar,
  viewing,
}: {
  app: AtlasApp
  threadId: ThreadId
  sidebar: SidebarModel
  viewing: ThreadId | null
}): AgentsControl {
  const agents = app.agents

  const subscribe = useCallback((listener: () => void) => agents.onChange(listener), [agents])
  const readOwn = useCallback(() => agents.list({ threadId }), [agents, threadId])
  const readEverywhere = useCallback(() => agents.listEverywhere(), [agents])

  const own = useSyncExternalStore(subscribe, readOwn)
  const everywhere = useSyncExternalStore(subscribe, readEverywhere)

  const visits = useCrewVisits(viewing)
  const members = useMemo(() => crewMembersOf({ snapshots: own, visits }), [own, visits])

  const now = useTickingNow(own.some(subagentShowsElapsed) || graceIsRunning({ members, viewing }))
  const spend = useAgentSpend({ app, children: own })

  return useMemo(() => {
    const subagents = subagentRows({ snapshots: own, now, spend, viewing })
    const { standings } = partitionCrew({
      crew: members,
      viewing,
      now,
      graceMs: DEFAULT_CREW_GRACE_MS,
    })
    const folded = foldCrew({
      rows: subagents,
      standings,
      cap: DEFAULT_CREW_CAP,
      keyOf: (row) => row.id,
      wentWrong: subagentWentWrong,
    })

    return {
      sidebar: withCrew({ model: sidebar, subagents: folded.shown, fold: folded }),
      everywhere,
      visits,
      running: subagents.filter(isSubagentRunning).length,
      count: subagents.length,
    }
  }, [everywhere, members, now, own, sidebar, spend, viewing, visits])
}
