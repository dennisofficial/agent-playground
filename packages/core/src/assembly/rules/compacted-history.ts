import { compactionWatermarks, type CompactionWatermark } from '../../compaction/watermark'
import { wrapInSystemReminder } from '../../context/render'
import type { Event } from '../../events/envelope'
import type { AssembledMessage } from '../assembled'
import { defineRule, type Rule } from '../rule'

const COMPACTION_PREFACE = 'Earlier turns of this conversation, compacted to save context:'

const compactionBlock = (summary: string): string =>
  wrapInSystemReminder(`${COMPACTION_PREFACE}\n\n${summary}`)

const summaryMessage = (watermark: CompactionWatermark): AssembledMessage => ({
  message: { role: 'user', content: [{ type: 'text', text: compactionBlock(watermark.summary) }] },
  origin: { eventId: watermark.id, seq: watermark.seq },
})

/**
 * Loaded context is current content rather than history, so it outlives the range that covers it.
 * That is what keeps a thread's instructions and skills in the prompt across a compaction without
 * anything having to restore them afterwards.
 */
const outlivesCompaction = (events: readonly Event[]): ReadonlySet<number> =>
  new Set(events.flatMap((event) => (event.type === 'context-loaded' ? [event.seq] : [])))

const covered = (args: { watermark: CompactionWatermark; seq: number }): boolean =>
  args.seq >= args.watermark.fromSeq &&
  args.seq <= args.watermark.throughSeq &&
  args.seq !== args.watermark.seq

function spliced({
  messages,
  summary,
}: {
  messages: readonly AssembledMessage[]
  summary: AssembledMessage
}): readonly AssembledMessage[] {
  const after = messages.findIndex((entry) => entry.origin.seq > summary.origin.seq)
  if (after === -1) return [...messages, summary]
  return [...messages.slice(0, after), summary, ...messages.slice(after)]
}

export function compactedHistory(): Rule {
  return defineRule({
    name: 'compactedHistory',
    apply: (input, ctx) => {
      const watermarks = compactionWatermarks(ctx.events)
      if (watermarks.length === 0) return input

      const spared = outlivesCompaction(ctx.events)

      return watermarks.reduce((assembled, watermark) => {
        const kept = assembled.messages.filter(
          (entry) =>
            spared.has(entry.origin.seq) || !covered({ watermark, seq: entry.origin.seq }),
        )

        return {
          system: assembled.system,
          messages: spliced({ messages: kept, summary: summaryMessage(watermark) }),
        }
      }, input)
    },
  })
}
