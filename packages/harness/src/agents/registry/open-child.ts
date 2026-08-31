import {
  agentLabel,
  EAgentStart,
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
  const thread = await threads.create({
    title: agentLabel({ agentType: agentType.name, intent }),
    agent: { spawnedBy, type: agentType.name },
    ...(spawner?.workspace == null ? {} : { workspace: spawner.workspace }),
    ...(spawner === undefined ? {} : { repo: spawner.repo }),
  })

  await log.append({
    threadId: thread.id,
    runId: ids.nextRunId(),
    drafts: [{ type: 'user-said', text: brief }],
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
