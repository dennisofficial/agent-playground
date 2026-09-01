import { describe, expect, it } from 'bun:test'

import { toEventId } from '../../../events/ids'
import type { Message } from '../../../message/message'
import type { ImagePart, MessagePart } from '../../../message/parts'
import type { ProviderOptions } from '../../../provider'
import type { Assembled, AssembledMessage } from '../../assembled'
import type { RuleContext } from '../../rule'
import { contextFor } from '../../__tests__/log-fixture'
import { MAX_IMAGE_BLOCKS, imagesInContext } from '../../rules/images'
import { ANTHROPIC_PROVIDER_ID, CACHE_LOOKBACK_BLOCKS, cacheBreakpoints } from '../cache-breakpoints'

const anthropicContext = (): RuleContext => ({
  ...contextFor({ events: [] }),
  provider: { id: ANTHROPIC_PROVIDER_ID, modelId: 'claude-opus-5' },
})

const entry = (message: Message, seq: number): AssembledMessage => ({
  message,
  origin: { eventId: toEventId(`event-${seq}`), seq },
})

const shot = (): ImagePart => ({ type: 'image', data: 'AAAA', mediaType: 'image/png' })

const shownWith = ({ images, seq }: { images: number; seq: number }): AssembledMessage =>
  entry(
    {
      role: 'user',
      content: [
        { type: 'text', text: `turn ${seq}` },
        ...Array.from({ length: images }, shot),
      ],
    },
    seq,
  )

const answered = (seq: number): AssembledMessage =>
  entry({ role: 'assistant', content: [{ type: 'text', text: `reply ${seq}` }] }, seq)

const conversation = ({ turns, images }: { turns: number; images: number }): AssembledMessage[] =>
  Array.from({ length: turns }, (_unused, index) => [
    shownWith({ images, seq: index * 2 + 1 }),
    answered(index * 2 + 2),
  ]).flat()

const apply = (messages: readonly AssembledMessage[]): Assembled =>
  cacheBreakpoints()({ system: [{ text: 'system' }], messages }, [], anthropicContext())

const cacheControlOf = (options: ProviderOptions | undefined): unknown =>
  options?.[ANTHROPIC_PROVIDER_ID]?.cacheControl

type Block = { position: number; type: string; marked: boolean }

function blocksOf(assembled: Assembled): readonly Block[] {
  const blocks: Block[] = []

  for (const message of assembled.messages) {
    const parts: readonly MessagePart[] = message.message.content
    for (const part of parts) {
      blocks.push({
        position: blocks.length + 1,
        type: part.type,
        marked: cacheControlOf(part.providerOptions) !== undefined,
      })
    }
  }

  return blocks
}

const markedPositions = (assembled: Assembled): readonly number[] =>
  blocksOf(assembled)
    .filter((block) => block.marked)
    .map((block) => block.position)

describe('cache breakpoints around image blocks', () => {
  it('treats an image as a cacheable position, unlike a reasoning block', () => {
    const marked = apply(conversation({ turns: 6, images: 2 }))
    const carrying = blocksOf(marked).filter((block) => block.marked && block.type === 'image')

    expect(carrying.length).toBeGreaterThan(0)
  })

  it('keeps the newest image inside the cached prefix rather than past the last breakpoint', () => {
    const marked = apply(conversation({ turns: 6, images: 2 }))
    const blocks = blocksOf(marked)

    const newestImage = blocks.filter((block) => block.type === 'image').at(-1)
    const lastBreakpoint = markedPositions(marked).at(-1)

    expect(newestImage).toBeDefined()
    expect(lastBreakpoint).toBeDefined()
    expect(newestImage?.position).toBeLessThanOrEqual(lastBreakpoint ?? 0)
  })

  it('marks the final block, so nothing trails the last breakpoint uncached', () => {
    const marked = apply(conversation({ turns: 6, images: 2 }))
    const blocks = blocksOf(marked)

    expect(markedPositions(marked).at(-1)).toBe(blocks.length)
  })

  it('never lets two breakpoints drift past the lookback window, image-heavy or not', () => {
    for (const images of [0, 1, 2, 5]) {
      const marked = apply(conversation({ turns: 8, images }))
      const positions = markedPositions(marked)

      for (const [index, position] of positions.entries()) {
        if (index === 0) continue
        const previous = positions[index - 1] ?? 0
        expect(position - previous).toBeLessThanOrEqual(CACHE_LOOKBACK_BLOCKS)
      }
    }
  })

  it('is unmoved by retirement, so a retired image costs its content and not its position', () => {
    const messages = conversation({ turns: 12, images: 2 })
    const retired = imagesInContext()({ system: [], messages }, anthropicContext())

    expect(retired.messages).not.toEqual(messages)
    expect(markedPositions(apply(retired.messages))).toEqual(markedPositions(apply(messages)))
  })

  it('keeps a transcript at the image limit within one lookback window of its last anchor', () => {
    const messages = conversation({ turns: MAX_IMAGE_BLOCKS, images: 1 })
    const positions = markedPositions(apply(messages))
    const blocks = blocksOf(apply(messages))

    expect(positions.at(-1)).toBe(blocks.length)
    expect(blocks.length - (positions.at(-2) ?? 0)).toBeLessThanOrEqual(CACHE_LOOKBACK_BLOCKS)
  })
})
