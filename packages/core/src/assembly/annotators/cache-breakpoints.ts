import type { Message } from '../../message/message'
import type { MessagePart } from '../../message/parts'
import type { ProviderOptions } from '../../provider'
import type { Assembled, AssembledMessage, SystemBlock } from '../assembled'
import { defineAnnotator, type Annotator } from '../rule'

export const ANTHROPIC_PROVIDER_ID = 'anthropic'

export enum ECacheTtl {
  FiveMinutes = '5m',
  OneHour = '1h',
}

// Anthropic rejects a request carrying a fifth `cache_control`, and each breakpoint looks back at
// most 20 content blocks for an entry a previous request wrote.
// https://docs.claude.com/en/docs/build-with-claude/prompt-caching
export const CACHE_BREAKPOINT_BUDGET = 4
export const CACHE_LOOKBACK_BLOCKS = 20
export const CACHE_ANCHOR_STRIDE_BLOCKS = 15

const CACHE_CONTROL_KEY = 'cacheControl'

export type CacheBreakpointOptions = {
  providerId?: string
  systemTtl?: ECacheTtl
  messageTtl?: ECacheTtl
}

function withCacheControl(args: { options: ProviderOptions | undefined; ttl: ECacheTtl }): ProviderOptions {
  const { options, ttl } = args
  const existing = options?.[ANTHROPIC_PROVIDER_ID] ?? {}

  return {
    ...options,
    [ANTHROPIC_PROVIDER_ID]: { ...existing, [CACHE_CONTROL_KEY]: { type: 'ephemeral', ttl } },
  }
}

function markLastSystemBlock(args: { blocks: readonly SystemBlock[]; ttl: ECacheTtl }): readonly SystemBlock[] {
  const last = args.blocks.length - 1
  if (last < 0) return args.blocks

  return args.blocks.map((block, index) =>
    index === last ? { ...block, providerOptions: withCacheControl({ options: block.providerOptions, ttl: args.ttl }) } : block,
  )
}

type BlockPosition = { messageIndex: number; partIndex: number }

type CacheablePositions = { anchors: readonly BlockPosition[]; tail: BlockPosition | undefined }

function cacheablePositions(messages: readonly AssembledMessage[]): CacheablePositions {
  const anchors: BlockPosition[] = []
  let blocks = 0
  let strideDue = false
  let tail: BlockPosition | undefined

  for (const [messageIndex, entry] of messages.entries()) {
    const parts: readonly MessagePart[] = entry.message.content

    for (const [partIndex, part] of parts.entries()) {
      blocks += 1
      strideDue = strideDue || blocks % CACHE_ANCHOR_STRIDE_BLOCKS === 0
      if (part.type === 'reasoning') continue

      tail = { messageIndex, partIndex }
      if (!strideDue) continue

      anchors.push(tail)
      strideDue = false
    }
  }

  return { anchors, tail }
}

const samePosition = (one: BlockPosition, other: BlockPosition): boolean =>
  one.messageIndex === other.messageIndex && one.partIndex === other.partIndex

function breakpointPositions(args: { messages: readonly AssembledMessage[]; budget: number }): readonly BlockPosition[] {
  const { anchors, tail } = cacheablePositions(args.messages)
  if (tail === undefined || args.budget < 1) return []

  const upstream = anchors.filter((anchor) => !samePosition(anchor, tail))
  return [...upstream.slice(Math.max(0, upstream.length - (args.budget - 1))), tail]
}

function marksByMessage(positions: readonly BlockPosition[]): ReadonlyMap<number, ReadonlySet<number>> {
  const marks = new Map<number, Set<number>>()

  for (const position of positions) {
    const parts = marks.get(position.messageIndex)
    if (parts === undefined) marks.set(position.messageIndex, new Set([position.partIndex]))
    else parts.add(position.partIndex)
  }

  return marks
}

function markMessage(args: { message: Message; parts: ReadonlySet<number>; ttl: ECacheTtl }): Message {
  const { message, parts, ttl } = args
  const marked = (options: ProviderOptions | undefined) => withCacheControl({ options, ttl })

  if (message.role === 'user') {
    return {
      ...message,
      content: message.content.map((part, index) =>
        parts.has(index) ? { ...part, providerOptions: marked(part.providerOptions) } : part,
      ),
    }
  }

  if (message.role === 'tool') {
    return {
      ...message,
      content: message.content.map((part, index) =>
        parts.has(index) ? { ...part, providerOptions: marked(part.providerOptions) } : part,
      ),
    }
  }

  return {
    ...message,
    content: message.content.map((part, index) =>
      parts.has(index) ? { ...part, providerOptions: marked(part.providerOptions) } : part,
    ),
  }
}

export function cacheBreakpoints(options: CacheBreakpointOptions = {}): Annotator {
  const providerId = options.providerId ?? ANTHROPIC_PROVIDER_ID
  const systemTtl = options.systemTtl ?? ECacheTtl.OneHour
  const messageTtl = options.messageTtl ?? ECacheTtl.FiveMinutes

  return defineAnnotator({
    name: 'cacheBreakpoints',
    apply: (input, _trace, ctx): Assembled => {
      if (ctx.provider.id !== providerId) return input

      const system = markLastSystemBlock({ blocks: input.system, ttl: systemTtl })
      const spentOnSystem = input.system.length > 0 ? 1 : 0
      const marks = marksByMessage(
        breakpointPositions({ messages: input.messages, budget: CACHE_BREAKPOINT_BUDGET - spentOnSystem }),
      )

      return {
        system,
        messages: input.messages.map((entry, index) => {
          const parts = marks.get(index)
          if (parts === undefined) return entry
          return { ...entry, message: markMessage({ message: entry.message, parts, ttl: messageTtl }) }
        }),
      }
    },
  })
}
