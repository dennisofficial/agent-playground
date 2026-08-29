import type { ThreadId, Event, EventLogPort } from '@dltech/atlas-core'
import type { ThreadStorePort, TurnLedgerPort, TurnSpend } from '@dltech/atlas-harness'

export type OpenedConversation = {
  threadId: ThreadId
  events: readonly Event[]
  turns: readonly TurnSpend[]
  name: string | null
}

export async function openConversation(args: {
  threads: ThreadStorePort
  log: EventLogPort
  ledger: TurnLedgerPort
  fresh: boolean
}): Promise<OpenedConversation> {
  const existing = args.fresh ? undefined : await args.threads.mostRecent()
  const thread = existing ?? (await args.threads.create({}))

  const [events, turns] = await Promise.all([
    args.log.read({ threadId: thread.id }),
    args.ledger.forThread({ threadId: thread.id }),
  ])

  return {
    threadId: thread.id,
    events,
    turns,
    name: thread.title ?? null,
  }
}
