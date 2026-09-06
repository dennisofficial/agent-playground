import type { Event, EventLogPort, ThreadId } from '@dltech/atlas-core'
import { rewindThread, type AgentRegistryPort, type ThreadStorePort } from '@dltech/atlas-harness'

type Said = Extract<Event, { type: 'user-said' }>

const wasSaid = (event: Event | undefined): event is Said => event?.type === 'user-said'

export async function retractTrailingSaid(args: {
  log: EventLogPort
  threads: ThreadStorePort
  agents: AgentRegistryPort
  threadId: ThreadId
  text: string
}): Promise<boolean> {
  const owned = await args.log.readOwn({ threadId: args.threadId })
  const last = owned.at(-1)

  if (!wasSaid(last) || last.text !== args.text) return false

  const rewound = await rewindThread({
    log: args.log,
    threads: args.threads,
    agents: args.agents,
    threadId: args.threadId,
    toSeq: last.seq - 1,
  })

  return rewound.ok
}
