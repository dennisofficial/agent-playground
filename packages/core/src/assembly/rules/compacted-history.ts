import { compactionWatermark } from '../../compaction/watermark'
import { wrapInSystemReminder } from '../../context/render'
import type { Event } from '../../events/envelope'
import type { AssembledMessage } from '../assembled'
import { defineRule, type Rule } from '../rule'

const COMPACTION_PREFACE = 'Earlier turns of this conversation, compacted to save context:'

const compactionBlock = (summary: string): string =>
  wrapInSystemReminder(`${COMPACTION_PREFACE}\n\n${summary}`)

const currentContextSeqs = (events: readonly Event[]): ReadonlySet<number> =>
  new Set(events.flatMap((event) => (event.type === 'context-loaded' ? [event.seq] : [])))

export function compactedHistory(): Rule {
  return defineRule({
    name: 'compactedHistory',
    apply: (input, ctx) => {
      const watermark = compactionWatermark(ctx.events)
      if (watermark === undefined) return input

      const summary: AssembledMessage = {
        message: { role: 'user', content: [{ type: 'text', text: compactionBlock(watermark.summary) }] },
        origin: { eventId: watermark.id, seq: watermark.seq },
      }

      const contextSeqs = currentContextSeqs(ctx.events)
      const instructions = input.messages.filter((entry) => contextSeqs.has(entry.origin.seq))
      const conversation = input.messages.filter((entry) => !contextSeqs.has(entry.origin.seq))

      return { system: input.system, messages: [...instructions, summary, ...conversation] }
    },
  })
}
