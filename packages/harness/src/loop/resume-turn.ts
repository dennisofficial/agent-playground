import { resumeDrafts, type EventDraft, type EventLogPort, type IdPort, type ThreadId } from '@dltech/atlas-core'

export async function appendResumeDrafts(args: {
  log: EventLogPort
  ids: IdPort
  threadId: ThreadId
}): Promise<readonly EventDraft[]> {
  const drafts = resumeDrafts(await args.log.read({ threadId: args.threadId }))
  if (drafts.length === 0) return drafts

  await args.log.append({ threadId: args.threadId, runId: args.ids.nextRunId(), drafts })
  return drafts
}
