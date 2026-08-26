import type { AssistantPart } from '../../events/body'
import type { Event, EventOfType, EventRef } from '../../events/envelope'
import type { TextPart, ToolCallPart, ToolResultPart } from '../../message/parts'
import type { AssembledMessage } from '../assembled'
import { defineRule, type Rule } from '../rule'

type OpenMessage =
  | { role: 'user'; content: TextPart[] }
  | { role: 'assistant'; content: (AssistantPart | ToolCallPart)[] }
  | { role: 'tool'; content: ToolResultPart[] }

type Group = { message: OpenMessage; origin: EventRef }

const originOf = (event: Event): EventRef => ({ eventId: event.id, seq: event.seq })

const NOTHING_TO_SAY = '(no output)'

const unrenderable = (output: unknown): string => `(unrenderable ${typeof output} output)`

const readableText = (text: string): string => (text.trim() === '' ? NOTHING_TO_SAY : text)

function renderOutput(output: unknown): string {
  if (typeof output === 'string') return readableText(output)
  if (output === undefined || output === null) return NOTHING_TO_SAY
  if (typeof output === 'bigint') return output.toString()
  if (typeof output === 'number' && !Number.isFinite(output)) return String(output)

  try {
    return JSON.stringify(output) ?? unrenderable(output)
  } catch {
    return unrenderable(output)
  }
}

function toolCallPart(event: EventOfType<'tool-called'>): ToolCallPart {
  return { type: 'tool-call', toolCallId: event.callId, toolName: event.name, input: event.input }
}

type Settlement = EventOfType<'tool-result'> | EventOfType<'tool-denied'>

function settlementOutput(event: Settlement): ToolResultPart['output'] {
  if (event.type === 'tool-denied') return { type: 'error-text', value: event.reason }
  if (event.error !== undefined) return { type: 'error-text', value: event.error.message }
  if (event.modelText !== undefined) return { type: 'text', value: readableText(event.modelText) }
  return { type: 'text', value: renderOutput(event.output) }
}

function toolResultPart(event: Settlement): ToolResultPart {
  return {
    type: 'tool-result',
    toolCallId: event.callId,
    toolName: event.name,
    output: settlementOutput(event),
  }
}

function appendCall({ groups, event }: { groups: Group[]; event: EventOfType<'tool-called'> }): void {
  const open = groups.at(-1)
  const part = toolCallPart(event)

  if (open?.message.role === 'assistant') {
    open.message.content.push(part)
    return
  }

  groups.push({ message: { role: 'assistant', content: [part] }, origin: originOf(event) })
}

function appendSettlement({ groups, event }: { groups: Group[]; event: Settlement }): void {
  const open = groups.at(-1)
  const part = toolResultPart(event)

  if (open?.message.role === 'tool') {
    open.message.content.push(part)
    return
  }

  groups.push({ message: { role: 'tool', content: [part] }, origin: originOf(event) })
}

function groupsFromEvents(events: readonly Event[]): Group[] {
  const groups: Group[] = []

  for (const event of events) {
    if (event.type === 'user-said') {
      groups.push({
        message: { role: 'user', content: [{ type: 'text', text: event.text }] },
        origin: originOf(event),
      })
      continue
    }

    if (event.type === 'assistant-said') {
      groups.push({ message: { role: 'assistant', content: [...event.parts] }, origin: originOf(event) })
      continue
    }

    if (event.type === 'tool-called') {
      appendCall({ groups, event })
      continue
    }

    if (event.type === 'tool-result' || event.type === 'tool-denied') {
      appendSettlement({ groups, event })
    }
  }

  return groups
}

export function messagesFromEvents(): Rule {
  return defineRule({
    name: 'messagesFromEvents',
    apply: (input, ctx) => ({
      system: input.system,
      messages: groupsFromEvents(ctx.events)
        .filter((group) => group.message.content.length > 0)
        .map((group): AssembledMessage => ({ message: group.message, origin: group.origin })),
    }),
  })
}
