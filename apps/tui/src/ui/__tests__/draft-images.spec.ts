import { EImageDelivery } from '@dltech/atlas-core'
import { describe, expect, it } from 'bun:test'

import type { ClipboardImage } from '../clipboard-image'
import type { LiveToken } from '../composer-tokens'
import { restoredImages, submissionOf } from '../draft-images'

const shot = (over: Partial<ClipboardImage> = {}): ClipboardImage => ({
  path: '/tmp/atlas/shot.png',
  mediaType: 'image/png',
  byteLength: 4096,
  width: 560,
  height: 280,
  delivery: EImageDelivery.Inline,
  tokens: 200,
  ...over,
})

const imageToken = (args: {
  ordinal: number
  image: ClipboardImage
  start?: number
  end?: number
}): LiveToken => ({
  id: args.ordinal,
  start: args.start ?? 0,
  end: args.end ?? 0,
  ordinal: args.ordinal,
  slot: { kind: 'image', ordinal: args.ordinal, settled: true, image: args.image },
})

describe('what the draft becomes on send', () => {
  it('carries an inline picture as bytes and leaves its tag naming it', () => {
    const sending = submissionOf({
      text: '[Image #1] why is this broken',
      tokens: [imageToken({ ordinal: 1, image: shot() })],
      load: () => 'AAAA',
    })

    expect(sending.text).toBe('[Image #1] why is this broken')
    expect(sending.images).toEqual([
      {
        path: '/tmp/atlas/shot.png',
        mediaType: 'image/png',
        data: 'AAAA',
        width: 560,
        height: 280,
      },
    ])
  })

  it('swaps a path-only picture for its path where the tag stood', () => {
    const text = 'look at [Image #1] closely'
    const start = text.indexOf('[Image #1]')
    const sending = submissionOf({
      text,
      tokens: [
        imageToken({
          ordinal: 1,
          start,
          end: start + '[Image #1]'.length,
          image: shot({ delivery: EImageDelivery.PathOnly }),
        }),
      ],
      load: () => 'AAAA',
    })

    expect(sending.images).toEqual([])
    expect(sending.text).toBe('look at [image /tmp/atlas/shot.png · 560×280] closely')
  })

  it('falls back to the path when the bytes have gone missing since the paste', () => {
    const text = '[Image #1]'
    const sending = submissionOf({
      text,
      tokens: [imageToken({ ordinal: 1, start: 0, end: text.length, image: shot() })],
      load: () => null,
    })

    expect(sending.images).toEqual([])
    expect(sending.text).toContain('[image /tmp/atlas/shot.png')
  })

  it('sends a pasted block back as its own text, labels gone from the message', () => {
    const text = 'see [Pasted text #2 +3 lines] here'
    const start = text.indexOf('[Pasted')
    const tokens: LiveToken[] = [
      {
        id: 2,
        start,
        end: start + '[Pasted text #2 +3 lines]'.length,
        ordinal: 0,
        slot: {
          kind: 'pasted',
          label: '[Pasted text #2 +3 lines]',
          content: 'one\ntwo\nthree',
        },
      },
    ]

    const sending = submissionOf({ text, tokens, load: () => 'AAAA' })

    expect(sending.text).toBe('see one\ntwo\nthree here')
    expect(sending.images).toEqual([])
  })

  it('untouched when the draft has no tokens', () => {
    const sending = submissionOf({
      text: 'never mind the screenshot',
      tokens: [],
      load: () => 'AAAA',
    })

    expect(sending.images).toEqual([])
    expect(sending.text).toBe('never mind the screenshot')
  })
})

describe('a queued message taken back into the draft', () => {
  it('brings its pictures back under the numbers the text still uses', () => {
    const restored = restoredImages({
      text: 'compare [Image #2] against [Image #4]',
      images: [
        { path: '/a.png', mediaType: 'image/png', data: 'A'.repeat(4), width: 560, height: 280 },
        { path: '/b.png', mediaType: 'image/png', data: 'A'.repeat(4), width: 560, height: 280 },
      ],
    })

    expect(restored.map((image) => image.ordinal)).toEqual([2, 4])
  })

  it('sends the pictures in the order the prose reads them', () => {
    const text = 'compare [Image #4] against [Image #2]'
    const fourth = text.indexOf('#4')
    const second = text.indexOf('#2')
    const tokens: LiveToken[] = [
      imageToken({ ordinal: 4, start: text.indexOf('[Image #4]'), end: text.indexOf('[Image #4]') + 11, image: shot({ path: '/a.png' }) }),
      imageToken({ ordinal: 2, start: text.indexOf('[Image #2]'), end: text.indexOf('[Image #2]') + 11, image: shot({ path: '/b.png' }) }),
    ]

    const sending = submissionOf({ text, tokens, load: (path) => path })

    expect(sending.images.map((image) => image.data)).toEqual(['/b.png', '/a.png'])
    expect(fourth).not.toBe(second)
  })

  it('survives a take-back and sends the same pictures again', () => {
    const text = 'compare [Image #2] against [Image #4]'
    const restored = restoredImages({
      text,
      images: [
        { path: '/a.png', mediaType: 'image/png', data: 'AAAA', width: 560, height: 280 },
        { path: '/b.png', mediaType: 'image/png', data: 'AAAA', width: 560, height: 280 },
      ],
    })

    const sending = submissionOf({
      text,
      tokens: restored.map((image) => imageToken({ ordinal: image.ordinal, image })),
      load: (path) => path,
    })

    expect(sending.images.map((image) => image.data)).toEqual(['/a.png', '/b.png'])
  })
})
