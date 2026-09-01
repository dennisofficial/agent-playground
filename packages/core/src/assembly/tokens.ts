import { decodeBase64, imageSize, visualTokens } from '../images/limits'
import type { Message } from '../message/message'
import type { ImagePart, MessagePart } from '../message/parts'
import type { Assembled } from './assembled'

const CHARS_PER_TOKEN = 4

const UNMEASURABLE_IMAGE_TOKENS = 1600

const textTokens = (text: string): number => Math.ceil(text.length / CHARS_PER_TOKEN)

function imageTokens(part: ImagePart): number {
  const size = imageSize({ bytes: decodeBase64(part.data), mediaType: part.mediaType })
  if (!size) return UNMEASURABLE_IMAGE_TOKENS

  return visualTokens({ byteLength: 0, ...size }) ?? UNMEASURABLE_IMAGE_TOKENS
}

function partTokens(part: MessagePart): number {
  if (part.type === 'text' || part.type === 'reasoning') return textTokens(part.text)
  if (part.type === 'image') return imageTokens(part)
  if (part.type === 'tool-call') return textTokens(JSON.stringify(part.input ?? null))
  if (part.output.type === 'content') {
    return part.output.value.reduce((total, inner) => total + partTokens(inner), 0)
  }
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
