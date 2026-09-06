import type { ThreadId } from '@dltech/atlas-core'

import { isStepping } from './child-state'
import type { AgentNoticeQueue } from './notices'
import type { AgentRoster } from './roster'

export function forgetRemovedChildren({
  roster,
  notices,
  threadId,
  agentIds,
}: {
  roster: AgentRoster
  notices: AgentNoticeQueue
  threadId: ThreadId
  agentIds: readonly ThreadId[]
}): void {
  for (const agentId of agentIds) {
    const child = roster.find(agentId)
    if (child === undefined || child.spawnedBy !== threadId) continue
    if (isStepping(child)) child.abort.abort()
    roster.remove(agentId)
  }

  notices.forgetAgents({ threadId, agentIds })
}
