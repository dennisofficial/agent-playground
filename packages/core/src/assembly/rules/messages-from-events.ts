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

type SettledCall = { part: ToolResultPart; origin: EventRef }

const UNSETTLED_CALL = 'This tool call did not complete and produced no result.'

function unsettledResult(call: ToolCallPart): ToolResultPart {
  return {
    type: 'tool-result',
    toolCallId: call.toolCallId,
    toolName: call.toolName,
    output: { type: 'error-text', value: UNSETTLED_CALL },
  }
}

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

function appendCall({ groups, event, open }: { groups: Group[]; event: EventOfType<'tool-called'>; open: Group | undefined }): Group {
  const part = toolCallPart(event)

  if (open !== undefined && open.message.role === 'assistant') {
    open.message.content.push(part)
    return open
  }

  const group: Group = { message: { role: 'assistant', content: [part] }, origin: originOf(event) }
  groups.push(group)
  return group
}

type Walk = { groups: readonly Group[]; settlements: ReadonlyMap<string, SettledCall> }

function walkEvents(events: readonly Event[]): Walk {
  const groups: Group[] = []
  const settlements = new Map<string, SettledCall>()
  let openAssistant: Group | undefined

  for (const event of events) {
    if (event.type === 'user-said') {
      groups.push({
        message: { role: 'user', content: [{ type: 'text', text: event.text }] },
        origin: originOf(event),
      })
      openAssistant = undefined
      continue
    }

    if (event.type === 'assistant-said') {
      openAssistant = { message: { role: 'assistant', content: [...event.parts] }, origin: originOf(event) }
      groups.push(openAssistant)
      continue
    }

    if (event.type === 'tool-called') {
      openAssistant = appendCall({ groups, event, open: openAssistant })
      continue
    }

    if (event.type === 'tool-result' || event.type === 'tool-denied') {
      settlements.set(event.callId, { part: toolResultPart(event), origin: originOf(event) })
      openAssistant = undefined
    }
  }

  return { groups, settlements }
}

function messagesForGroup({
  group,
  settlements,
}: {
  group: Group
  settlements: ReadonlyMap<string, SettledCall>
}): AssembledMessage[] {
  if (group.message.content.length === 0) return []

  const self: AssembledMessage = { message: group.message, origin: group.origin }
  if (group.message.role !== 'assistant') return [self]

  const calls = group.message.content.flatMap((part) => (part.type === 'tool-call' ? [part] : []))
  if (calls.length === 0) return [self]

  const answers = calls.map((call) => settlements.get(call.toolCallId))
  const content = calls.map((call, index) => answers[index]?.part ?? unsettledResult(call))
  const origin = answers.find((answer) => answer !== undefined)?.origin ?? group.origin

  return [self, { message: { role: 'tool', content }, origin }]
}

export function messagesFromEvents(): Rule {
  return defineRule({
    name: 'messagesFromEvents',
    apply: (input, ctx) => {
      const { groups, settlements } = walkEvents(ctx.events)

      return {
        system: input.system,
        messages: groups.flatMap((group) => messagesForGroup({ group, settlements })),
      }
    },
  })
}
