import { EImageDelivery, imageTag } from '@dltech/atlas-core'
import { describe, expect, it } from 'bun:test'

import type { ClipboardImage } from '../clipboard-image'
import {
  attachImage,
  keptImages,
  noDraftImages,
  restoredImages,
  submissionOf,
  type DraftImage,
} from '../draft-images'

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

const attached = (...images: readonly ClipboardImage[]): readonly DraftImage[] =>
  images.reduce<readonly DraftImage[]>(
    (held, image) => attachImage({ images: held, image }),
    noDraftImages,
  )

const tagsFor = (images: readonly DraftImage[]): string =>
  images.map((image) => imageTag(image.ordinal)).join(' ')

describe('the pictures riding along with a draft', () => {
  it('numbers a new one past the highest already there, not past the count', () => {
    const two = attached(shot(), shot())
    const again = attachImage({ images: [two[0] as DraftImage], image: shot() })

    expect(again.map((image) => image.ordinal)).toEqual([1, 2])
  })

  it('keeps only the ones the draft still names', () => {
    const three = attached(shot({ path: '/a.png' }), shot({ path: '/b.png' }), shot({ path: '/c.png' }))
    const kept = keptImages({ images: three, text: 'look at [Image #1] and [Image #3]' })

    expect(kept.map((image) => image.path)).toEqual(['/a.png', '/c.png'])
  })

  it('takes them in the order the prose reads them, not the order they were pasted', () => {
    const two = attached(shot({ path: '/a.png' }), shot({ path: '/b.png' }))
    const kept = keptImages({ images: two, text: '[Image #2] before [Image #1]' })

    expect(kept.map((image) => image.path)).toEqual(['/b.png', '/a.png'])
  })

  it('drops every picture when the draft names none of them', () => {
    expect(keptImages({ images: attached(shot()), text: 'never mind' })).toEqual([])
  })

  it('ignores a tag naming a picture that was never attached', () => {
    expect(keptImages({ images: noDraftImages, text: '[Image #7]' })).toEqual([])
  })
})

describe('what the draft becomes on send', () => {
  it('carries an inline picture as bytes and leaves its tag naming it', () => {
    const images = attached(shot())
    const sending = submissionOf({
      text: `${tagsFor(images)} why is this broken`,
      images,
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
    const images = attached(shot({ delivery: EImageDelivery.PathOnly }))
    const sending = submissionOf({
      text: `look at ${tagsFor(images)} closely`,
      images,
      load: () => 'AAAA',
    })

    expect(sending.images).toEqual([])
    expect(sending.text).toBe('look at [image /tmp/atlas/shot.png · 560×280] closely')
  })

  it('falls back to the path when the bytes have gone missing since the paste', () => {
    const images = attached(shot())
    const sending = submissionOf({ text: tagsFor(images), images, load: () => null })

    expect(sending.images).toEqual([])
    expect(sending.text).toContain('[image /tmp/atlas/shot.png')
  })

  it('sends nothing but the words when the operator backspaced the tag away', () => {
    const sending = submissionOf({
      text: 'never mind the screenshot',
      images: attached(shot()),
      load: () => 'AAAA',
    })

    expect(sending.images).toEqual([])
    expect(sending.text).toBe('never mind the screenshot')
  })

  it('sends the pictures in the order the prose reads them', () => {
    const images = attached(shot({ path: '/a.png' }), shot({ path: '/b.png' }))
    const sending = submissionOf({
      text: 'compare [Image #2] against [Image #1]',
      images,
      load: (path) => path,
    })

    expect(sending.images.map((image) => image.data)).toEqual(['/b.png', '/a.png'])
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

  it('survives a take-back and sends the same pictures again', () => {
    const text = 'compare [Image #2] against [Image #4]'
    const restored = restoredImages({
      text,
      images: [
        { path: '/a.png', mediaType: 'image/png', data: 'AAAA', width: 560, height: 280 },
        { path: '/b.png', mediaType: 'image/png', data: 'AAAA', width: 560, height: 280 },
      ],
    })

    const sending = submissionOf({ text, images: restored, load: (path) => path })

    expect(sending.images.map((image) => image.data)).toEqual(['/a.png', '/b.png'])
  })
})
