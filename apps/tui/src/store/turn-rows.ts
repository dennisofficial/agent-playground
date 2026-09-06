import { replacedRanges, type Event } from '@dltech/atlas-core'
import { ETurnStatus, type TurnSpend } from '@dltech/atlas-harness'

import { EAuthor, EEntryKind, type TurnEndedEntry } from './transcript-model'

const SHOWN: readonly string[] = [ETurnStatus.Completed, ETurnStatus.Interrupted]

function lastSeqByRun(events: readonly Event[]): ReadonlyMap<string, number> {
  const replaced = replacedRanges(events)
  const last = new Map<string, number>()

  for (const event of events) {
    if (replaced.some((range) => event.seq >= range.fromSeq && event.seq <= range.throughSeq)) {
      continue
    }

    const held = last.get(event.runId)
    if (held === undefined || event.seq > held) last.set(event.runId, event.seq)
  }

  return last
}

/**
 * A turn is drawn where its own last event sits, so a rewound or summarised turn loses its line
 * with the rows it described rather than outliving them: the ledger keeps its row for accounting
 * either way. Bookkeeping rows spared inside a replaced range are not a seat — the summary already
 * speaks for those turns.
 */
export function turnsBySeq(args: {
  events: readonly Event[]
  turns: readonly TurnSpend[]
}): ReadonlyMap<number, TurnSpend> {
  const last = lastSeqByRun(args.events)
  const bySeq = new Map<number, TurnSpend>()

  for (const turn of args.turns) {
    if (!SHOWN.includes(turn.status)) continue

    const seq = last.get(turn.runId)
    if (seq === undefined) continue

    bySeq.set(seq, turn)
  }

  return bySeq
}

export function turnEndedEntry(turn: TurnSpend): TurnEndedEntry {
  return {
    kind: EEntryKind.TurnEnded,
    author: EAuthor.Model,
    key: `turn-${turn.runId}`,
    text: '',
    durationMs: turn.durationMs,
    outputTokens: turn.outputTokens,
    endedAt: turn.endedAt,
    interrupted: turn.status === ETurnStatus.Interrupted,
  }
}
