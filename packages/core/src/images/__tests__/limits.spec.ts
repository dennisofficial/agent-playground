import { describe, expect, test } from 'bun:test'

import {
  decodeBase64,
  EImageDelivery,
  gifSize,
  imageMediaType,
  imageSize,
  jpegSize,
  MAX_API_EDGE,
  MAX_INLINE_BYTES,
  planDelivery,
  pngSize,
  visualTokens,
  webpSize,
} from '../limits'
import { projectedSize } from '../projection'

const bytes = (...values: number[]): Uint8Array => new Uint8Array(values)

const bigEndian32 = (value: number): number[] => [(value >> 24) & 0xff, (value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff]

const png = (width: number, height: number): Uint8Array =>
  bytes(
    0x89,
    0x50,
    0x4e,
    0x47,
    0x0d,
    0x0a,
    0x1a,
    0x0a,
    ...bigEndian32(13),
    0x49,
    0x48,
    0x44,
    0x52,
    ...bigEndian32(width),
    ...bigEndian32(height),
  )

const jpeg = (width: number, height: number): Uint8Array =>
  bytes(
    0xff,
    0xd8,
    0xff,
    0xe0,
    0x00,
    0x10,
    ...Array.from({ length: 14 }, () => 0x00),
    0xff,
    0xc0,
    0x00,
    0x11,
    0x08,
    (height >> 8) & 0xff,
    height & 0xff,
    (width >> 8) & 0xff,
    width & 0xff,
    0x03,
    ...Array.from({ length: 9 }, () => 0x00),
  )

const gif = (width: number, height: number): Uint8Array =>
  bytes(
    0x47,
    0x49,
    0x46,
    0x38,
    0x39,
    0x61,
    width & 0xff,
    (width >> 8) & 0xff,
    height & 0xff,
    (height >> 8) & 0xff,
  )

const webpVp8x = (width: number, height: number): Uint8Array => {
  const value = new Uint8Array(30)
  value.set([0x52, 0x49, 0x46, 0x46], 0)
  value.set([0x57, 0x45, 0x42, 0x50], 8)
  value.set([0x56, 0x50, 0x38, 0x58], 12)
  const w = width - 1
  const h = height - 1
  value.set([w & 0xff, (w >> 8) & 0xff, (w >> 16) & 0xff], 24)
  value.set([h & 0xff, (h >> 8) & 0xff, (h >> 16) & 0xff], 27)
  return value
}

describe('header parsing', () => {
  test('reads a PNG out of its IHDR chunk', () => {
    expect(pngSize(png(1024, 768))).toEqual({ width: 1024, height: 768 })
  })

  test('reads a JPEG out of its first SOFn frame', () => {
    expect(jpegSize(jpeg(640, 480))).toEqual({ width: 640, height: 480 })
  })

  test('reads a GIF out of its logical screen descriptor', () => {
    expect(gifSize(gif(300, 200))).toEqual({ width: 300, height: 200 })
  })

  test('reads an extended WebP', () => {
    expect(webpSize(webpVp8x(800, 600))).toEqual({ width: 800, height: 600 })
  })

  test('each parser doubles as a signature check', () => {
    expect(pngSize(jpeg(10, 10))).toBeNull()
    expect(jpegSize(png(10, 10))).toBeNull()
    expect(gifSize(png(10, 10))).toBeNull()
    expect(webpSize(png(10, 10))).toBeNull()
    expect(pngSize(bytes(1, 2, 3))).toBeNull()
  })

  test('sniffs the media type from the bytes', () => {
    expect(imageMediaType(png(4, 4))).toBe('image/png')
    expect(imageMediaType(jpeg(4, 4))).toBe('image/jpeg')
    expect(imageMediaType(gif(4, 4))).toBe('image/gif')
    expect(imageMediaType(webpVp8x(4, 4))).toBe('image/webp')
    expect(imageMediaType(bytes(0, 1, 2, 3, 4, 5, 6, 7, 8, 9))).toBeNull()
  })

  test('dispatches on the declared media type', () => {
    expect(imageSize({ bytes: png(50, 60), mediaType: 'image/png' })).toEqual({ width: 50, height: 60 })
    expect(imageSize({ bytes: png(50, 60), mediaType: 'image/tiff' })).toBeNull()
  })
})

describe('delivery planning', () => {
  test('an ordinary screenshot inlines untouched', () => {
    expect(planDelivery({ byteLength: 400_000, width: 1440, height: 900 })).toEqual({
      delivery: EImageDelivery.Inline,
    })
  })

  test('sends an image past the tier long edge untouched, because the API downscales it anyway', () => {
    expect(planDelivery({ byteLength: 3_500_000, width: 6000, height: 4000 })).toEqual({
      delivery: EImageDelivery.Inline,
    })
  })

  test('costs the same tokens sent whole as it would resized, which is why it is sent whole', () => {
    const facts = { byteLength: 3_500_000, width: 6000, height: 4000 }
    const projected = projectedSize({ size: { width: facts.width, height: facts.height } })

    expect(visualTokens(facts)).toBe(visualTokens({ ...facts, ...projected }))
  })

  test('falls back to the path past the edge the API refuses outright', () => {
    const plan = planDelivery({ byteLength: 1_000, width: MAX_API_EDGE + 1, height: 10 })

    expect(plan.delivery).toBe(EImageDelivery.PathOnly)
    expect(plan.reason).toContain(String(MAX_API_EDGE))
  })

  test('falls back to the path when the bytes exceed what the wire allows', () => {
    const plan = planDelivery({ byteLength: MAX_INLINE_BYTES + 1, width: 2000, height: 2000 })

    expect(plan.delivery).toBe(EImageDelivery.PathOnly)
    expect(plan.reason).toContain('inline limit')
  })

  test('weighs the bytes even when the dimensions could not be read', () => {
    expect(planDelivery({ byteLength: 10 }).delivery).toBe(EImageDelivery.Inline)
    expect(planDelivery({ byteLength: MAX_INLINE_BYTES + 1 }).delivery).toBe(
      EImageDelivery.PathOnly,
    )
  })
})

describe('visual tokens', () => {
  test('counts 28-pixel patches', () => {
    expect(visualTokens({ byteLength: 0, width: 280, height: 280 })).toBe(100)
  })

  test('measures the size the API will actually read, not the one supplied', () => {
    const huge = visualTokens({ byteLength: 0, width: 5120, height: 5120 })
    const projected = projectedSize({ size: { width: 5120, height: 5120 } })

    expect(huge).toBe(visualTokens({ byteLength: 0, ...projected }))
  })

  test('a retina screenshot is expensive, not incidental', () => {
    expect(visualTokens({ byteLength: 0, width: 3024, height: 1964 })).toBeGreaterThan(4000)
  })

  test('is null when the image could not be measured', () => {
    expect(visualTokens({ byteLength: 1000 })).toBeNull()
  })
})

describe('decodeBase64', () => {
  test('round-trips bytes', () => {
    const original = png(1024, 768)
    const encoded = Buffer.from(original).toString('base64')

    expect(decodeBase64(encoded)).toEqual(original)
  })

  test('ignores padding and whitespace', () => {
    expect(decodeBase64('aGk=')).toEqual(new Uint8Array([0x68, 0x69]))
    expect(decodeBase64('aG\nkg\ndGhlcmU=')).toEqual(new Uint8Array(Buffer.from('hi there')))
  })
})
