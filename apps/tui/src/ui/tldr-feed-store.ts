import type { ThreadId } from '@dltech/atlas-core'
import type { TldrFeed } from '@dltech/atlas-harness'

export type PendingTldr = { anchorSeq: number; text: string }

const pending = new Map<string, PendingTldr>()

const listeners = new Set<() => void>()

const wake = (): void => {
  for (const listener of [...listeners]) listener()
}

export const tldrFeed: TldrFeed = {
  started({ threadId, anchorSeq }) {
    pending.set(threadId, { anchorSeq, text: '' })
    wake()
  },
  chunk({ threadId, text }) {
    const held = pending.get(threadId)
    if (held === undefined) return
    pending.set(threadId, { ...held, text })
    wake()
  },
  finished({ threadId }) {
    if (pending.delete(threadId)) wake()
  },
}

export const pendingTldrOf = (threadId: ThreadId): PendingTldr | undefined =>
  pending.get(threadId)

export const subscribeTldrFeed = (listener: () => void): (() => void) => {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}
