import type { Event } from '../../events/envelope'
import type { Assembled } from '../assembled'
import type { RuleContext } from '../rule'

const lastEventOf = (events: readonly Event[]): Event | undefined => events[events.length - 1]

export function appendedAtTail({
  input,
  ctx,
  text,
}: {
  input: Assembled
  ctx: RuleContext
  text: string
}): Assembled {
  const anchor = lastEventOf(ctx.events)
  if (anchor === undefined) return input

  return {
    system: input.system,
    messages: [
      ...input.messages,
      {
        message: { role: 'user' as const, content: [{ type: 'text' as const, text }] },
        origin: { eventId: anchor.id, seq: anchor.seq },
      },
    ],
  }
}
