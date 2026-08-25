import type { Event } from '../../events/envelope'
import type { AssembledMessage } from '../assembled'
import { defineRule, type Rule } from '../rule'

function spokenMessage(event: Event): AssembledMessage | undefined {
  const origin = { eventId: event.id, seq: event.seq }

  if (event.type === 'user-said') {
    return { message: { role: 'user', content: [{ type: 'text', text: event.text }] }, origin }
  }

  if (event.type === 'assistant-said' && event.parts.length > 0) {
    return { message: { role: 'assistant', content: [...event.parts] }, origin }
  }

  return undefined
}

export function messagesFromEvents(): Rule {
  return defineRule({
    name: 'messagesFromEvents',
    apply: (input, ctx) => ({
      system: input.system,
      messages: ctx.events.flatMap((event) => spokenMessage(event) ?? []),
    }),
  })
}
