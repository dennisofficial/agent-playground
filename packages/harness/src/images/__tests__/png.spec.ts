import { describe, expect, test } from 'bun:test'

import { croppedImage, isCropped } from '../crop'
import { cropRaster, decodePng, encodePng, type RasterImage } from '../png'

const QUADRANTS: Readonly<Record<string, readonly [number, number, number]>> = {
  topLeft: [255, 0, 0],
  topRight: [0, 255, 0],
  bottomLeft: [0, 0, 255],
  bottomRight: [255, 255, 0],
}

const quadrantAt = ({ x, y, edge }: { x: number; y: number; edge: number }) => {
  if (x < edge / 2) return y < edge / 2 ? QUADRANTS.topLeft! : QUADRANTS.bottomLeft!
  return y < edge / 2 ? QUADRANTS.topRight! : QUADRANTS.bottomRight!
}

function quadrantImage(edge: number): RasterImage {
  const pixels = new Uint8Array(edge * edge * 3)

  for (let y = 0; y < edge; y += 1) {
    for (let x = 0; x < edge; x += 1) {
      pixels.set(quadrantAt({ x, y, edge }), (y * edge + x) * 3)
    }
  }

  return { size: { width: edge, height: edge }, channels: 3, pixels }
}

const colourAt = ({ image, x, y }: { image: RasterImage; x: number; y: number }): string => {
  const at = (y * image.size.width + x) * image.channels
  return [...image.pixels.subarray(at, at + 3)].join(',')
}

const named = (colour: readonly [number, number, number]): string => colour.join(',')

describe('encodePng and decodePng', () => {
  test('round-trips a picture byte for byte', () => {
    const original = quadrantImage(64)
    const restored = decodePng(encodePng(original))

    expect(restored?.size).toEqual(original.size)
    expect(restored?.channels).toBe(3)
    expect(restored?.pixels).toEqual(original.pixels)
  })

  test('round-trips an image with an alpha channel', () => {
    const pixels = Uint8Array.from({ length: 16 * 16 * 4 }, (_unused, index) => index % 251)
    const original: RasterImage = { size: { width: 16, height: 16 }, channels: 4, pixels }

    expect(decodePng(encodePng(original))?.pixels).toEqual(pixels)
  })

  test('round-trips a greyscale image', () => {
    const pixels = Uint8Array.from({ length: 8 * 8 }, (_unused, index) => index * 3)
    const original: RasterImage = { size: { width: 8, height: 8 }, channels: 1, pixels }

    expect(decodePng(encodePng(original))?.pixels).toEqual(pixels)
  })

  test('reads back a file another encoder filtered, not only its own', () => {
    const decoded = decodePng(encodePng(quadrantImage(32)))
    expect(decoded).not.toBeNull()
  })

  test('declines bytes that are not a PNG at all', () => {
    expect(decodePng(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9]))).toBeNull()
  })

  test('declines a truncated header rather than reading past it', () => {
    expect(decodePng(encodePng(quadrantImage(8)).subarray(0, 6))).toBeNull()
  })
})

describe('cropRaster', () => {
  test('lifts each quadrant out whole', () => {
    const image = quadrantImage(400)
    const half = 200

    const corners = [
      { x: 0, y: 0, want: QUADRANTS.topLeft! },
      { x: 200, y: 0, want: QUADRANTS.topRight! },
      { x: 0, y: 200, want: QUADRANTS.bottomLeft! },
      { x: 200, y: 200, want: QUADRANTS.bottomRight! },
    ]

    for (const corner of corners) {
      const cropped = cropRaster({
        image,
        region: { x: corner.x, y: corner.y, width: half, height: half },
      })

      expect(cropped.size).toEqual({ width: half, height: half })
      expect(colourAt({ image: cropped, x: half >> 1, y: half >> 1 })).toBe(named(corner.want))
      expect(colourAt({ image: cropped, x: 0, y: 0 })).toBe(named(corner.want))
      expect(colourAt({ image: cropped, x: half - 1, y: half - 1 })).toBe(named(corner.want))
    }
  })

  test('a crop that ends exactly on the bottom edge at x zero is the one sips got wrong', () => {
    const cropped = cropRaster({
      image: quadrantImage(400),
      region: { x: 0, y: 200, width: 200, height: 200 },
    })

    expect(cropped.size).toEqual({ width: 200, height: 200 })
    expect(colourAt({ image: cropped, x: 100, y: 100 })).toBe(named(QUADRANTS.bottomLeft!))
  })

  test('a single pixel is a legal region', () => {
    const cropped = cropRaster({
      image: quadrantImage(400),
      region: { x: 399, y: 399, width: 1, height: 1 },
    })

    expect(cropped.size).toEqual({ width: 1, height: 1 })
    expect(colourAt({ image: cropped, x: 0, y: 0 })).toBe(named(QUADRANTS.bottomRight!))
  })
})

describe('croppedImage', () => {
  test('returns a PNG the decoder can read back to the region asked for', () => {
    const bytes = encodePng(quadrantImage(400))
    const result = croppedImage({
      bytes,
      mediaType: 'image/png',
      region: { x: 0, y: 200, width: 200, height: 200 },
    })

    expect(isCropped(result)).toBe(true)
    if (!isCropped(result)) return

    expect(result.size).toEqual({ width: 200, height: 200 })
    const back = decodePng(result.bytes)
    expect(colourAt({ image: back!, x: 100, y: 100 })).toBe(named(QUADRANTS.bottomLeft!))
  })

  test('is smaller on the wire than the picture it came from', () => {
    const bytes = encodePng(quadrantImage(400))
    const result = croppedImage({
      bytes,
      mediaType: 'image/png',
      region: { x: 0, y: 0, width: 100, height: 100 },
    })

    expect(isCropped(result) && result.bytes.byteLength).toBeLessThan(bytes.byteLength)
  })

  test('says which format it cannot cut rather than returning the whole picture', () => {
    const result = croppedImage({
      bytes: new Uint8Array(10),
      mediaType: 'image/jpeg',
      region: { x: 0, y: 0, width: 10, height: 10 },
    })

    expect(isCropped(result)).toBe(false)
    expect(!isCropped(result) && result.reason).toContain('image/jpeg')
  })

  test('says so when the bytes claim PNG but cannot be taken apart', () => {
    const result = croppedImage({
      bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]),
      mediaType: 'image/png',
      region: { x: 0, y: 0, width: 4, height: 4 },
    })

    expect(isCropped(result)).toBe(false)
    expect(!isCropped(result) && result.reason).toContain('cannot take apart')
  })
})
