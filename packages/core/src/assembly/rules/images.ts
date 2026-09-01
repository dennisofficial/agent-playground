import { decodeBase64, imageSize } from '../../images/limits'
import type { Message } from '../../message/message'
import type { ImagePart, TextPart, ToolResultPart } from '../../message/parts'
import type { AssembledMessage } from '../assembled'
import { defineRule, type Rule } from '../rule'

export const IMAGES_KEPT_IN_CONTEXT = 2

export type ImagesKeptSource = () => number

type VisualPart = TextPart | ImagePart

const describedSize = (part: ImagePart): string => {
  const size = imageSize({ bytes: decodeBase64(part.data), mediaType: part.mediaType })
  if (size === null) return part.mediaType

  return `${part.mediaType} ${size.width}×${size.height}`
}

const described = (part: ImagePart): string =>
  part.source === undefined ? describedSize(part) : `${part.source} · ${describedSize(part)}`

const withoutPixels = (part: ImagePart): TextPart => ({
  type: 'text',
  text: `[image dropped from context: ${described(part)}]`,
})

const imagesInParts = (parts: readonly VisualPart[]): number =>
  parts.reduce((count, part) => count + (part.type === 'image' ? 1 : 0), 0)

const imagesInResult = (part: ToolResultPart): number =>
  part.output.type === 'content' ? imagesInParts(part.output.value) : 0

function imagesInMessage(message: Message): number {
  if (message.role === 'user') return imagesInParts(message.content)
  if (message.role === 'tool') {
    return message.content.reduce((count, part) => count + imagesInResult(part), 0)
  }
  return 0
}

type Downgrades = { claim: () => boolean }

const downgrades = (allowance: number): Downgrades => {
  let claimed = 0
  return {
    claim: () => {
      if (claimed >= allowance) return false
      claimed += 1
      return true
    },
  }
}

const downgradedParts = ({
  parts,
  budget,
}: {
  parts: readonly VisualPart[]
  budget: Downgrades
}): readonly VisualPart[] =>
  parts.map((part) => (part.type === 'image' && budget.claim() ? withoutPixels(part) : part))

function downgradedResult({
  part,
  budget,
}: {
  part: ToolResultPart
  budget: Downgrades
}): ToolResultPart {
  if (part.output.type !== 'content') return part
  if (imagesInParts(part.output.value) === 0) return part

  return {
    ...part,
    output: { type: 'content', value: downgradedParts({ parts: part.output.value, budget }) },
  }
}

function downgradedMessage({ message, budget }: { message: Message; budget: Downgrades }): Message {
  if (message.role === 'user') {
    return { ...message, content: downgradedParts({ parts: message.content, budget }) }
  }
  if (message.role === 'tool') {
    return {
      ...message,
      content: message.content.map((part) => downgradedResult({ part, budget })),
    }
  }
  return message
}

function downgradedEntry({
  entry,
  budget,
}: {
  entry: AssembledMessage
  budget: Downgrades
}): AssembledMessage {
  if (imagesInMessage(entry.message) === 0) return entry
  return { ...entry, message: downgradedMessage({ message: entry.message, budget }) }
}

export function imagesInContext({
  keep = () => IMAGES_KEPT_IN_CONTEXT,
}: { keep?: ImagesKeptSource | undefined } = {}): Rule {
  return defineRule({
    name: 'imagesInContext',
    apply: (input) => {
      const total = input.messages.reduce(
        (count, entry) => count + imagesInMessage(entry.message),
        0,
      )

      const allowance = total - Math.max(0, keep())
      if (allowance <= 0) return input

      const budget = downgrades(allowance)

      return {
        system: input.system,
        messages: input.messages.map((entry) => downgradedEntry({ entry, budget })),
      }
    },
  })
}
