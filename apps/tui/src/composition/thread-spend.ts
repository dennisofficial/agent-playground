import type { ThreadId } from '@dltech/atlas-core'
import type { TurnLedgerPort, TurnSpend } from '@dltech/atlas-harness'

import { ENoticeTone, NOTICE_WARN_MS, notify } from '../ui/notice-store'

export type ThreadSpend = { turns: readonly TurnSpend[] }

const UNREADABLE = 'what this conversation has spent could not be read'

/**
 * A conversation must open regardless: the transcript is the product and the cost is a note beside
 * it. What it must never do is fall back to a figure, because zero would read as a free turn.
 */
export async function readThreadSpend(args: {
  ledger: TurnLedgerPort
  threadId: ThreadId
}): Promise<ThreadSpend> {
  try {
    return { turns: await args.ledger.forThread({ threadId: args.threadId }) }
  } catch {
    notify({ key: 'spend-ledger', text: UNREADABLE, tone: ENoticeTone.Warn, ttlMs: NOTICE_WARN_MS })
    return { turns: [] }
  }
}
