import { decodeBase64, imageSize, visualTokens, type ImageSize } from '../images/limits'
import { DEFAULT_IMAGE_TIER, type EImageTier } from '../images/projection'
import type { Message } from '../message/message'
import type { ImagePart, MessagePart } from '../message/parts'
import type { Assembled } from './assembled'

const CHARS_PER_TOKEN = 4

const UNMEASURABLE_IMAGE_TOKENS = 1600

const textTokens = (text: string): number => Math.ceil(text.length / CHARS_PER_TOKEN)

/**
 * Decoding megabytes of base64 to re-read a header costs more than the count is worth, and every
 * part built from an event or a tool result already carries what the header would have said.
 */
const measured = (part: ImagePart): ImageSize | null =>
  part.width === undefined || part.height === undefined
    ? imageSize({ bytes: decodeBase64(part.data), mediaType: part.mediaType })
    : { width: part.width, height: part.height }

function imageTokens({ part, tier }: { part: ImagePart; tier: EImageTier }): number {
  const size = measured(part)
  if (!size) return UNMEASURABLE_IMAGE_TOKENS

  return visualTokens({ byteLength: 0, tier, ...size }) ?? UNMEASURABLE_IMAGE_TOKENS
}

function partTokens({ part, tier }: { part: MessagePart; tier: EImageTier }): number {
  if (part.type === 'text' || part.type === 'reasoning') return textTokens(part.text)
  if (part.type === 'image') return imageTokens({ part, tier })
  if (part.type === 'tool-call') return textTokens(JSON.stringify(part.input ?? null))
  if (part.output.type === 'content') {
    return part.output.value.reduce((total, inner) => total + partTokens({ part: inner, tier }), 0)
  }
  return textTokens(JSON.stringify(part.output))
}

export function estimateMessageTokens(message: Message, tier: EImageTier = DEFAULT_IMAGE_TIER): number {
  const parts: readonly MessagePart[] = message.content
  return parts.reduce((total, part) => total + partTokens({ part, tier }), 0)
}

/**
 * A picture's cost depends on which resolution tier the model reads at, so the estimator is bound to
 * a model before it is handed to the loop rather than assuming one.
 */
export const estimateTokensFor =
  (tier: EImageTier) =>
  (assembled: Assembled): number => {
    const systemTokens = assembled.system.reduce((total, block) => total + textTokens(block.text), 0)
    return assembled.messages.reduce(
      (total, assembledMessage) => total + estimateMessageTokens(assembledMessage.message, tier),
      systemTokens,
    )
  }

export const estimateTokens = estimateTokensFor(DEFAULT_IMAGE_TIER)
