import type { ThreadId } from '@dltech/atlas-core'
import type { AgentSnapshot } from '@dltech/atlas-harness'
import { useEffect, useState } from 'react'

import { agentSpendOf, SPEND_UNAVAILABLE, type AgentSpend } from '../store'
import type { AtlasApp } from './compose'

export type AgentSpendByChild = ReadonlyMap<ThreadId, AgentSpend>

const NOTHING_READ: AgentSpendByChild = new Map()

/**
 * A child's tokens are its own ledger rows, asked for one thread at a time rather than through the
 * tree rollup, which answers for the whole supervision tree at once. A read that throws is held as
 * unavailable rather than as zero: the row must not claim a child was free.
 */
export function useAgentSpend(args: {
  app: AtlasApp
  children: readonly AgentSnapshot[]
}): AgentSpendByChild {
  const { app, children } = args
  const [spend, setSpend] = useState<AgentSpendByChild>(NOTHING_READ)

  useEffect(() => {
    if (children.length === 0) {
      setSpend(NOTHING_READ)
      return
    }

    let live = true
    void Promise.all(
      children.map(async (child): Promise<[ThreadId, AgentSpend]> => {
        try {
          return [child.agentId, agentSpendOf(await app.ledger.forThread({ threadId: child.agentId }))]
        } catch {
          return [child.agentId, SPEND_UNAVAILABLE]
        }
      }),
    ).then((read) => {
      if (live) setSpend(new Map(read))
    })

    return () => {
      live = false
    }
  }, [app.ledger, children])

  return spend
}
