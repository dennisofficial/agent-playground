import { describe, expect, it } from 'bun:test'

import {
  base64Bytes,
  imagePathLine,
  imageTag,
  imageTagAround,
  imageTagOrdinals,
  imageTagSpans,
  inlinable,
  nearerEdgeOf,
  replaceImageTag,
} from '../attached'

describe('the tag standing in for a picture in the draft', () => {
  it('is numbered, so prose can name which picture it means', () => {
    expect(imageTag(1)).toBe('[Image #1]')
    expect(imageTag(12)).toBe('[Image #12]')
  })

  it('reads the ordinals back in the order the draft refers to them', () => {
    expect(imageTagOrdinals('compare [Image #2] against [Image #1]')).toEqual([2, 1])
  })

  it('finds nothing in a draft that never pasted anything', () => {
    expect(imageTagOrdinals('why is this broken')).toEqual([])
  })

  it('counts a repeated ordinal once, at the position it is first read', () => {
    expect(imageTagOrdinals('[Image #1] and again [Image #1]')).toEqual([1])
  })

  it('still reports both occurrences as spans, because each one is deletable', () => {
    expect(imageTagSpans('[Image #1] and again [Image #1]')).toEqual([
      { start: 0, end: 10, ordinal: 1 },
      { start: 21, end: 31, ordinal: 1 },
    ])
  })




  it('reports where each tag sits so the composer can paint it', () => {
    expect(imageTagSpans('see [Image #3] here')).toEqual([{ start: 4, end: 14, ordinal: 3 }])
  })

  it('ignores a number that is not a tag', () => {
    expect(imageTagOrdinals('issue #3 and [Image#4] and [image #5]')).toEqual([])
  })

  it('swaps a tag for whatever stands in its place, wherever it sits', () => {
    const swapped = replaceImageTag({
      text: 'look at [Image #1] closely',
      ordinal: 1,
      replacement: '[image /tmp/a.png]',
    })

    expect(swapped).toBe('look at [image /tmp/a.png] closely')
  })

  it('leaves a draft alone when the ordinal is not in it', () => {
    const text = 'look at [Image #1]'
    expect(replaceImageTag({ text, ordinal: 2, replacement: 'x' })).toBe(text)
  })
})

describe('naming a picture the model cannot be shown', () => {
  it('gives the path and the size when both are known', () => {
    expect(imagePathLine({ path: '/tmp/a.png', width: 10, height: 20 })).toBe(
      '[image /tmp/a.png · 10×20]',
    )
  })

  it('gives the path alone when the size could not be read', () => {
    expect(imagePathLine({ path: '/tmp/a.png' })).toBe('[image /tmp/a.png]')
  })
})

describe('whether a picture can ride along as bytes', () => {
  it('counts three bytes for every four characters of base64', () => {
    expect(base64Bytes('AAAA')).toBe(3)
  })

  it('turns down one past the inline ceiling', () => {
    expect(inlinable({ path: '/a.png', data: 'A'.repeat(8 * 1024 * 1024), width: 10, height: 10 })).toBe(false)
  })

  it('takes one inside it', () => {
    expect(inlinable({ path: '/a.png', data: 'AAAA', width: 10, height: 10 })).toBe(true)
  })
})

describe('a caret clicked into the middle of a tag', () => {
  const text = 'look at [Image #1] closely'

  it('names the tag it landed inside', () => {
    expect(imageTagAround({ text, offset: 12 })).toEqual({ start: 8, end: 18, ordinal: 1 })
  })

  it('counts neither edge as inside, because the edges are where it may rest', () => {
    expect(imageTagAround({ text, offset: 8 })).toBeNull()
    expect(imageTagAround({ text, offset: 18 })).toBeNull()
  })

  it('leaves by whichever side it was closest to', () => {
    const span = { start: 8, end: 18, ordinal: 1 }

    expect(nearerEdgeOf({ span, offset: 10 })).toBe(8)
    expect(nearerEdgeOf({ span, offset: 16 })).toBe(18)
  })
})
