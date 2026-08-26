import { estimateMessageTokens } from '../assembly/tokens'
import type { Event } from '../events/envelope'
import type { Message } from '../message/message'
import type { ToolCallPart, ToolResultOutput, ToolResultPart } from '../message/parts'
import type { ModelUsage } from '../stream/chunk'

const callPart = (args: { name: string; input: unknown }): ToolCallPart => ({
  type: 'tool-call',
  toolCallId: args.name,
  toolName: args.name,
  input: args.input,
})

const resultPart = (args: { name: string; output: ToolResultOutput }): ToolResultPart => ({
  type: 'tool-result',
  toolCallId: args.name,
  toolName: args.name,
  output: args.output,
})

function messageOfEvent(event: Event): Message | undefined {
  if (event.type === 'user-said') {
    return { role: 'user', content: [{ type: 'text', text: event.text }] }
  }

  if (event.type === 'assistant-said') {
    if (event.parts.length === 0) return undefined
    return { role: 'assistant', content: [...event.parts] }
  }

  if (event.type === 'tool-called') {
    return { role: 'assistant', content: [callPart({ name: event.name, input: event.input })] }
  }

  if (event.type === 'tool-result') {
    return {
      role: 'tool',
      content: [
        resultPart({ name: event.name, output: { type: 'text', value: JSON.stringify(event.output) } }),
      ],
    }
  }

  if (event.type === 'tool-denied') {
    return { role: 'user', content: [{ type: 'text', text: event.reason }] }
  }

  if (event.type === 'context-loaded') {
    return { role: 'user', content: [{ type: 'text', text: event.content }] }
  }

  return undefined
}

/**
 * What the next turn will carry, estimated from the branch alone. It deliberately leaves out the
 * system preamble, which the harness assembles and the reader cannot see.
 */
export function estimateEventTokens(events: readonly Event[]): number {
  return events.reduce((total, event) => {
    const message = messageOfEvent(event)
    return message === undefined ? total : total + estimateMessageTokens(message)
  }, 0)
}

/**
 * What the next request will carry, as the model itself counted it: everything it was sent plus
 * everything it just wrote. Reported usage beats the estimate because it includes the system
 * preamble and the provider's own tokenizer; until a step reports one, the estimate is all there is.
 */
export function contextTokens(args: {
  reported: ModelUsage | null
  events: readonly Event[]
}): number {
  const { reported } = args
  if (reported === null) return estimateEventTokens(args.events)
  return Math.max(0, reported.inputTokens) + Math.max(0, reported.outputTokens)
}
