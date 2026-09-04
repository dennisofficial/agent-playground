import type { EventDraft, EventLogPort, IdPort, ThreadId } from '@dltech/atlas-core'

export type TeardownSource = {
  closeAll(): Promise<void>
  threadsAwaitingNotice(): readonly ThreadId[]
  drainNotifications(args: { threadId: ThreadId }): readonly EventDraft[]
}

export async function teardownSession(args: {
  sources: readonly TeardownSource[]
  log: EventLogPort
  ids: IdPort
  stopSandbox: () => Promise<unknown>
}): Promise<void> {
  try {
    await Promise.all(args.sources.map((source) => source.closeAll()))

    for (const source of args.sources) {
      for (const threadId of source.threadsAwaitingNotice()) {
        const drafts = source.drainNotifications({ threadId })
        if (drafts.length === 0) continue

        await args.log.append({ threadId, runId: args.ids.nextRunId(), drafts })
      }
    }
  } finally {
    await args.stopSandbox().catch(() => undefined)
  }
}
