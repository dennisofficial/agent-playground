import {
  forkTarget,
  type ThreadId,
  type EForkMode,
  type EForkRefusal,
  type EventLogPort,
} from '@dltech/atlas-core'

import type { ThreadStorePort, ThreadSummary } from './thread-store'

export type ForkResult =
  | { ok: true; thread: ThreadSummary; inherited: number }
  | { ok: false; refusal: EForkRefusal; reason: string }

export async function forkConversation({
  log,
  threads,
  threadId,
  seq,
  mode,
  title,
}: {
  log: EventLogPort
  threads: ThreadStorePort
  threadId: ThreadId
  seq: number
  mode: EForkMode
  title?: string | undefined
}): Promise<ForkResult> {
  const events = await log.read({ threadId })

  const target = forkTarget({ events, seq, mode })
  if (!target.allowed) return { ok: false, refusal: target.refusal, reason: target.reason }

  const thread = await threads.fork({
    from: threadId,
    seq,
    mode,
    ...(title === undefined ? {} : { title }),
  })

  return { ok: true, thread, inherited: events.filter((event) => event.seq <= seq).length }
}
