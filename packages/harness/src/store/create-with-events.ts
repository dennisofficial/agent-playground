import type {
  ClockPort,
  Event,
  EventDraft,
  IdPort,
  RunId,
  ThreadId,
} from '@dltech/atlas-core'

import type { Prisma } from '../../prisma/generated/client'
import { appendWithin } from './event-log'
import type { SupervisedAgent } from './thread-store'

export class ThreadNeedsOpeningDrafts extends Error {
  constructor() {
    super(
      'a thread opened with its first events must be given at least one draft: an empty log reads as no one having spoken, so the thread would exist unable to ever take a step',
    )
    this.name = 'ThreadNeedsOpeningDrafts'
  }
}

export type OpenThreadArgs = {
  threadId?: ThreadId | undefined
  drafts: readonly EventDraft[]
  runId: RunId
  title?: string | undefined
  workspace?: string | undefined
  repo?: string | null | undefined
  agent?: SupervisedAgent | undefined
}

export async function createThreadWithEvents({
  tx,
  ids,
  clock,
  threadId: given,
  drafts,
  runId,
  title,
  workspace,
  repo,
  agent,
}: OpenThreadArgs & {
  tx: Prisma.TransactionClient
  ids: IdPort
  clock: ClockPort
}): Promise<{ threadId: ThreadId; events: Event[] }> {
  if (drafts.length === 0) throw new ThreadNeedsOpeningDrafts()

  const at = clock.now()
  const threadId = given ?? ids.nextThreadId()

  await tx.thread.create({
    data: {
      id: threadId,
      createdAt: at,
      updatedAt: at,
      ...(title === undefined ? {} : { title }),
      ...(workspace === undefined ? {} : { workspace }),
      ...(repo === undefined ? {} : { repo }),
      ...(agent === undefined ? {} : { spawnerThreadId: agent.spawnedBy, agentType: agent.type }),
    },
  })

  const events = await appendWithin({ tx, clock, ids, args: { threadId, runId, drafts } })
  return { threadId, events }
}
