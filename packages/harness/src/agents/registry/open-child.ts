import {
  agentLabel,
  EAgentStart,
  EMessageOrigin,
  type EventLogPort,
  type IdPort,
  type ThreadId,
} from '@dltech/atlas-core'

import type { ThreadStorePort } from '../../store'
import type { AgentType } from '../types'

/**
 * The order is the invariant. The brief is the child's own first `user-said`, without which
 * `awaitsReply` reads the thread as nobody's turn and the child never takes a step; `agent-spawned`
 * lands on the spawner's log, never on the child's.
 *
 * The spawn stays outside the child's transaction deliberately. Every write here runs under
 * `retryOnWriteConflict`, which re-runs the whole closure on SQLITE_BUSY, so a transaction spanning
 * both threads that lost the race to the parent's own live turn would roll back and mint a second
 * child thread on the retry. That trades a crash-sized window for a contention-sized one.
 */
export async function openChildThread({
  threads,
  log,
  ids,
  spawnedBy,
  agentType,
  brief,
  intent,
}: {
  threads: ThreadStorePort
  log: EventLogPort
  ids: IdPort
  spawnedBy: ThreadId
  agentType: AgentType
  brief: string
  intent: string
}): Promise<ThreadId> {
  const spawner = await threads.find({ threadId: spawnedBy })
  const { thread } = await threads.createWithFirstEvents({
    runId: ids.nextRunId(),
    drafts: [{ type: 'user-said', text: brief, via: EMessageOrigin.ParentAgent }],
    title: agentLabel({ agentType: agentType.name, intent }),
    agent: { spawnedBy, type: agentType.name },
    ...(spawner?.workspace == null ? {} : { workspace: spawner.workspace }),
    ...(spawner === undefined ? {} : { repo: spawner.repo }),
  })

  await log.append({
    threadId: spawnedBy,
    runId: ids.nextRunId(),
    drafts: [
      {
        type: 'agent-spawned',
        agentId: thread.id,
        agentType: agentType.name,
        intent,
        mode: EAgentStart.Fresh,
      },
    ],
  })

  return thread.id
}
