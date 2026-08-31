import {
  agentProgress,
  EAgentStatus,
  EKilledBy,
  lostAgentEnding,
  type ClockPort,
  type EventLogPort,
  type IdPort,
  type ThreadId,
} from '@dltech/atlas-core'

import type { ThreadStorePort } from '../../store'
import { isStepping, snapshotOf, type ChildState } from './child-state'
import type { AgentSnapshot, UnloggedChild } from './snapshot'

const NOTHING_SETTLED: readonly AgentSnapshot[] = Object.freeze([])

export const wasLost = (child: ChildState): boolean =>
  !isStepping(child) && child.endedAt === undefined

export async function settleLostChildren({
  log,
  ids,
  clock,
  children,
  threadId,
}: {
  log: EventLogPort
  ids: IdPort
  clock: ClockPort
  children: readonly ChildState[]
  threadId: ThreadId
}): Promise<readonly AgentSnapshot[]> {
  const lost = children.filter(wasLost)
  if (lost.length === 0) return NOTHING_SETTLED

  const settled: AgentSnapshot[] = []

  for (const child of lost) {
    const progress = agentProgress(await log.readOwn({ threadId: child.agentId }))
    const [recorded] = await log.append({
      threadId,
      runId: ids.nextRunId(),
      drafts: [lostAgentEnding({ agent: child, progress })],
    })

    child.status = EAgentStatus.Stopped
    child.killedBy = EKilledBy.Unrecorded
    child.turns = progress.turns
    child.toolCalls = progress.toolCalls
    child.lastText = progress.prose
    child.endedAt = recorded?.at ?? clock.now()

    settled.push(snapshotOf(child))
  }

  return settled
}

const NOTHING_UNLOGGED: readonly UnloggedChild[] = Object.freeze([])

export async function unloggedChildren({
  threads,
  threadId,
  known,
}: {
  threads: ThreadStorePort
  threadId: ThreadId
  known: ReadonlySet<ThreadId>
}): Promise<readonly UnloggedChild[]> {
  const spawned = (await threads.spawned({ threadId })).filter((thread) => !known.has(thread.id))
  if (spawned.length === 0) return NOTHING_UNLOGGED

  return spawned.map((thread) => ({
    agentId: thread.id,
    agentType: thread.agent?.type,
    title: thread.title,
    startedAt: thread.createdAt,
  }))
}
