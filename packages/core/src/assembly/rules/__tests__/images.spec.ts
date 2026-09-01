import { describe, expect, it } from 'bun:test'

import type { Assembled, AssembledMessage } from '../../assembled'
import { toEventId } from '../../../events/ids'
import type { ImagePart } from '../../../message/parts'
import { estimateTokens } from '../../tokens'
import { contextFor, log } from '../../__tests__/log-fixture'
import { IMAGES_KEPT_IN_CONTEXT, imagesInContext } from '../images'

const png = ({ width, height }: { width: number; height: number }): string => {
  const bytes = new Uint8Array(24)
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0)
  bytes.set([0x00, 0x00, 0x00, 0x0d], 8)
  bytes.set([0x49, 0x48, 0x44, 0x52], 12)
  bytes.set([width >>> 24, (width >>> 16) & 0xff, (width >>> 8) & 0xff, width & 0xff], 16)
  bytes.set([height >>> 24, (height >>> 16) & 0xff, (height >>> 8) & 0xff, height & 0xff], 20)

  return btoa(String.fromCharCode(...bytes))
}

const shot = (index: number): ImagePart => ({
  type: 'image',
  data: png({ width: 1024 + index, height: 768 }),
  mediaType: 'image/png',
})

const origin = (seq: number): AssembledMessage['origin'] => ({
  eventId: toEventId(`event-${seq}`),
  seq,
})

const shownByUser = (index: number): AssembledMessage => ({
  message: { role: 'user', content: [{ type: 'text', text: `look ${index}` }, shot(index)] },
  origin: origin(index + 1),
})

const readByTool = (index: number): AssembledMessage => ({
  message: {
    role: 'tool',
    content: [
      {
        type: 'tool-result',
        toolCallId: `call-${index}`,
        toolName: 'read',
        output: { type: 'content', value: [{ type: 'text', text: 'shot.png' }, shot(index)] },
      },
    ],
  },
  origin: origin(index + 1),
})

const assembledOf = (messages: readonly AssembledMessage[]): Assembled => ({
  system: [],
  messages,
})

const ctx = contextFor({ events: log([]) })

const partsOf = (assembled: Assembled): readonly string[] =>
  assembled.messages.flatMap((entry) =>
    entry.message.content.flatMap((part) => {
      if (part.type === 'image') return ['image']
      if (part.type === 'text') return [part.text]
      if (part.type === 'tool-result' && part.output.type === 'content') {
        return part.output.value.map((inner) => (inner.type === 'image' ? 'image' : inner.text))
      }
      return []
    }),
  )

const textAt = ({ assembled, index }: { assembled: Assembled; index: number }): string => {
  const part = assembled.messages[index]?.message.content[1]
  return part !== undefined && part.type === 'text' ? part.text : ''
}

describe('imagesInContext', () => {
  it('keeps the newest images whole and leaves a description where the older ones were', () => {
    const input = assembledOf([0, 1, 2, 3, 4].map(shownByUser))

    const parts = partsOf(imagesInContext()(input, ctx))
    const kept = parts.filter((part) => part === 'image')
    const dropped = parts.filter((part) => part.startsWith('[image dropped'))

    expect(kept.length).toBe(IMAGES_KEPT_IN_CONTEXT)
    expect(dropped.length).toBe(3)
  })

  it('drops the oldest and never the newest, whatever order the log put them in', () => {
    const input = assembledOf([0, 1, 2].map(shownByUser))

    const output = imagesInContext({ keep: () => 1 })(input, ctx)

    expect(partsOf(output)).toEqual([
      'look 0',
      '[image dropped from context: image/png 1024×768]',
      'look 1',
      '[image dropped from context: image/png 1025×768]',
      'look 2',
      'image',
    ])
  })

  it('names the media type and the dimensions, so the model knows what it can read again', () => {
    const input = assembledOf([shownByUser(0), shownByUser(1)])

    const output = imagesInContext({ keep: () => 1 })(input, ctx)

    expect(textAt({ assembled: output, index: 0 })).toBe(
      '[image dropped from context: image/png 1024×768]',
    )
  })

  it('names the file it came from, so the description is something the model can act on', () => {
    const fromDisk: AssembledMessage = {
      message: {
        role: 'user',
        content: [
          { type: 'text', text: 'look' },
          { ...shot(0), source: 'docs/login.png' },
        ],
      },
      origin: origin(1),
    }

    const output = imagesInContext({ keep: () => 0 })(assembledOf([fromDisk]), ctx)

    expect(textAt({ assembled: output, index: 0 })).toBe(
      '[image dropped from context: docs/login.png · image/png 1024×768]',
    )
  })

  it('downgrades an image a tool returned, not only one the user pasted', () => {
    const input = assembledOf([readByTool(0), readByTool(1), shownByUser(2)])

    const output = imagesInContext({ keep: () => 1 })(input, ctx)

    expect(partsOf(output)).toEqual([
      'shot.png',
      '[image dropped from context: image/png 1024×768]',
      'shot.png',
      '[image dropped from context: image/png 1025×768]',
      'look 2',
      'image',
    ])
  })

  it('re-reads the budget each assembly, so a settings change reaches the next step', () => {
    let kept = 2
    const rule = imagesInContext({ keep: () => kept })
    const input = assembledOf([0, 1, 2].map(shownByUser))

    const before = partsOf(rule(input, ctx)).filter((part) => part === 'image').length
    kept = 1
    const after = partsOf(rule(input, ctx)).filter((part) => part === 'image').length

    expect([before, after]).toEqual([2, 1])
  })

  it('leaves a log below the threshold exactly as the content rules built it', () => {
    const input = assembledOf([shownByUser(0), shownByUser(1)])

    expect(imagesInContext()(input, ctx)).toBe(input)
  })

  it('is a no-op on a thread that never carried an image', () => {
    const input = assembledOf([
      { message: { role: 'user', content: [{ type: 'text', text: 'hello' }] }, origin: origin(1) },
    ])

    expect(imagesInContext({ keep: () => 0 })(input, ctx)).toBe(input)
  })

  it('stops re-billing the pixels every step, which is the whole point', () => {
    const input = assembledOf([0, 1, 2, 3, 4].map(shownByUser))

    const before = estimateTokens(input)
    const after = estimateTokens(imagesInContext()(input, ctx))

    expect(before).toBeGreaterThan(after * 2)
  })

  it('keeps the description when the bytes carry no readable header', () => {
    const unreadable: AssembledMessage = {
      message: {
        role: 'user',
        content: [
          { type: 'text', text: 'look' },
          { type: 'image', data: 'bm90IGFuIGltYWdl', mediaType: 'image/png' },
        ],
      },
      origin: origin(1),
    }

    const output = imagesInContext({ keep: () => 0 })(assembledOf([unreadable]), ctx)

    expect(textAt({ assembled: output, index: 0 })).toBe('[image dropped from context: image/png]')
  })
})
