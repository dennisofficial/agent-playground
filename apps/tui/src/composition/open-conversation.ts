import type { ThreadId, Event, EventLogPort } from '@dltech/atlas-core'
import type { ThreadStorePort } from '@dltech/atlas-harness'

export type OpenedConversation = {
  threadId: ThreadId
  events: readonly Event[]
  name: string | null
}

export async function openConversation(args: {
  threads: ThreadStorePort
  log: EventLogPort
  fresh: boolean
}): Promise<OpenedConversation> {
  const existing = args.fresh ? undefined : await args.threads.mostRecent()
  const thread = existing ?? (await args.threads.create({}))

  return {
    threadId: thread.id,
    events: await args.log.read({ threadId: thread.id }),
    name: thread.title ?? null,
  }
}
