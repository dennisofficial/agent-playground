import type { EventDraft, EventLogPort, IdPort, ThreadId } from '@dltech/atlas-core'

export type TeardownSource = {
  closeAll(): Promise<void>
  threadsAwaitingNotice(): readonly ThreadId[]
  drainNotifications(args: { threadId: ThreadId }): readonly EventDraft[]
}

/**
 * Teardown kills every background shell, and those endings are worth keeping: reopening the
 * conversation should say where the dev server went. Nothing is left running to drain them, so the
 * close path appends what teardown produced before the database goes — each ending to the thread
 * that started the shell, which is not necessarily the one on screen when the session ended. The
 * sandbox stops only after that walk: stopping the container reaps the processes inside it, and
 * drained-afterwards endings would arrive empty.
 */
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
