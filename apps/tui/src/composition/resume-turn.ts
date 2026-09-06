import { EResume, resumePlan, type Event, type EventLogPort, type ThreadId } from '@dltech/atlas-core'
import { rewindThread, type AgentRegistryPort, type ThreadStorePort } from '@dltech/atlas-harness'

export enum EDiscard {
  Discarded = 'discarded',
  Refused = 'refused',
  Nothing = 'nothing',
}

export type Discard =
  | { type: EDiscard.Discarded }
  | { type: EDiscard.Refused; reason: string }
  | { type: EDiscard.Nothing }

export async function discardInterrupted(args: {
  log: EventLogPort
  threads: ThreadStorePort
  agents: AgentRegistryPort
  threadId: ThreadId
}): Promise<Discard> {
  const { log, threads, agents, threadId } = args

  const events: readonly Event[] = await log.readOwn({ threadId })
  const plan = resumePlan(events)
  if (plan.kind !== EResume.Nudge) return { type: EDiscard.Nothing }

  const rewound = await rewindThread({
    log,
    threads,
    agents,
    threadId,
    toSeq: plan.interrupted.seq - 1,
  })
  if (!rewound.ok) return { type: EDiscard.Refused, reason: rewound.reason }

  return { type: EDiscard.Discarded }
}
