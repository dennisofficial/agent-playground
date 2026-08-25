import type { Message } from '../message/message'
import type { MessagePart } from '../message/parts'
import type { Assembled } from './assembled'

const CHARS_PER_TOKEN = 4

const textTokens = (text: string): number => Math.ceil(text.length / CHARS_PER_TOKEN)

function partTokens(part: MessagePart): number {
  if (part.type === 'text' || part.type === 'reasoning') return textTokens(part.text)
  if (part.type === 'tool-call') return textTokens(JSON.stringify(part.input ?? null))
  return textTokens(JSON.stringify(part.output))
}

export function estimateMessageTokens(message: Message): number {
  const parts: readonly MessagePart[] = message.content
  return parts.reduce((total, part) => total + partTokens(part), 0)
}

export function estimateTokens(assembled: Assembled): number {
  const systemTokens = assembled.system.reduce((total, block) => total + textTokens(block.text), 0)
  return assembled.messages.reduce(
    (total, assembledMessage) => total + estimateMessageTokens(assembledMessage.message),
    systemTokens,
  )
}
