import { rewindTarget, type ThreadId, type ERewindRefusal, type EventLogPort } from '@dltech/atlas-core'

import type { ThreadStorePort } from './thread-store'

export type RewindResult =
  | { ok: true; discarded: number }
  | { ok: false; refusal: ERewindRefusal; reason: string }

export async function rewindThread({
  log,
  threads,
  threadId,
  toSeq,
}: {
  log: EventLogPort
  threads: ThreadStorePort
  threadId: ThreadId
  toSeq: number
}): Promise<RewindResult> {
  const events = await log.read({ threadId })
  const owned = await log.readOwn({ threadId })
  const firstOwned = owned[0]
  const floorSeq = firstOwned === undefined ? await log.head({ threadId }) : firstOwned.seq - 1

  const target = rewindTarget({ events, toSeq, floorSeq })
  if (!target.allowed) return { ok: false, refusal: target.refusal, reason: target.reason }

  await threads.rewind({ threadId, toSeq })
  return { ok: true, discarded: owned.filter((event) => event.seq > toSeq).length }
}
