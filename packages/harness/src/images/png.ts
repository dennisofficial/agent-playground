import { deflateSync, inflateSync } from 'node:zlib'

import type { ImageRegion, ImageSize } from '@dltech/atlas-core'

const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]

const COLOUR_CHANNELS: Readonly<Record<number, number>> = { 0: 1, 2: 3, 4: 2, 6: 4 }

export type RasterImage = { size: ImageSize; channels: number; pixels: Uint8Array }

type Chunk = { type: string; data: Uint8Array }

function* chunksOf(bytes: Uint8Array): Generator<Chunk> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let at = SIGNATURE.length

  while (at + 8 <= bytes.byteLength) {
    const length = view.getUint32(at)
    const type = String.fromCharCode(...bytes.subarray(at + 4, at + 8))
    yield { type, data: bytes.subarray(at + 8, at + 8 + length) }
    at += 12 + length
  }
}

const paeth = (left: number, above: number, corner: number): number => {
  const estimate = left + above - corner
  const toLeft = Math.abs(estimate - left)
  const toAbove = Math.abs(estimate - above)
  const toCorner = Math.abs(estimate - corner)

  if (toLeft <= toAbove && toLeft <= toCorner) return left
  return toAbove <= toCorner ? above : corner
}

function unfiltered({
  raw,
  size,
  channels,
}: {
  raw: Uint8Array
  size: ImageSize
  channels: number
}): Uint8Array {
  const stride = size.width * channels
  const pixels = new Uint8Array(stride * size.height)
  let at = 0

  for (let row = 0; row < size.height; row += 1) {
    const filter = raw[at] ?? 0
    at += 1

    for (let index = 0; index < stride; index += 1) {
      const value = raw[at + index] ?? 0
      const left = index >= channels ? (pixels[row * stride + index - channels] ?? 0) : 0
      const above = row > 0 ? (pixels[(row - 1) * stride + index] ?? 0) : 0
      const corner =
        index >= channels && row > 0 ? (pixels[(row - 1) * stride + index - channels] ?? 0) : 0

      const restored =
        filter === 0
          ? value
          : filter === 1
            ? value + left
            : filter === 2
              ? value + above
              : filter === 3
                ? value + ((left + above) >> 1)
                : value + paeth(left, above, corner)

      pixels[row * stride + index] = restored & 0xff
    }

    at += stride
  }

  return pixels
}

/**
 * Only the colour types that carry a whole byte per channel, which is every screenshot a desktop
 * produces. An interlaced or palletted file is declined rather than guessed at.
 */
export function decodePng(bytes: Uint8Array): RasterImage | null {
  if (!SIGNATURE.every((byte, index) => bytes[index] === byte)) return null

  const parts: Uint8Array[] = []
  let size: ImageSize | null = null
  let channels = 0

  for (const chunk of chunksOf(bytes)) {
    if (chunk.type === 'IHDR') {
      const view = new DataView(chunk.data.buffer, chunk.data.byteOffset, chunk.data.byteLength)
      if (chunk.data[8] !== 8) return null
      if (chunk.data[12] !== 0) return null

      channels = COLOUR_CHANNELS[chunk.data[9] ?? -1] ?? 0
      if (channels === 0) return null
      size = { width: view.getUint32(0), height: view.getUint32(4) }
    }
    if (chunk.type === 'IDAT') parts.push(chunk.data)
    if (chunk.type === 'IEND') break
  }

  if (size === null || parts.length === 0) return null

  const joined = new Uint8Array(parts.reduce((total, part) => total + part.byteLength, 0))
  let at = 0
  for (const part of parts) {
    joined.set(part, at)
    at += part.byteLength
  }

  return { size, channels, pixels: unfiltered({ raw: inflateSync(joined), size, channels }) }
}

const CRC_TABLE = Uint32Array.from({ length: 256 }, (_unused, index) => {
  let value = index
  for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
  return value >>> 0
})

function crc32(bytes: Uint8Array): number {
  let value = 0xffffffff
  for (const byte of bytes) value = (CRC_TABLE[(value ^ byte) & 0xff] ?? 0) ^ (value >>> 8)
  return (value ^ 0xffffffff) >>> 0
}

function chunk({ type, data }: { type: string; data: Uint8Array }): Uint8Array {
  const out = new Uint8Array(12 + data.byteLength)
  const view = new DataView(out.buffer)

  view.setUint32(0, data.byteLength)
  for (const [index, character] of [...type].entries()) out[4 + index] = character.charCodeAt(0)
  out.set(data, 8)
  view.setUint32(8 + data.byteLength, crc32(out.subarray(4, 8 + data.byteLength)))

  return out
}

export function encodePng(image: RasterImage): Uint8Array {
  const { size, channels, pixels } = image
  const stride = size.width * channels

  const raw = new Uint8Array((stride + 1) * size.height)
  for (let row = 0; row < size.height; row += 1) {
    raw[row * (stride + 1)] = 0
    raw.set(pixels.subarray(row * stride, (row + 1) * stride), row * (stride + 1) + 1)
  }

  const header = new Uint8Array(13)
  const view = new DataView(header.buffer)
  view.setUint32(0, size.width)
  view.setUint32(4, size.height)
  header[8] = 8
  header[9] = channels === 1 ? 0 : channels === 2 ? 4 : channels === 3 ? 2 : 6

  const pieces = [
    Uint8Array.from(SIGNATURE),
    chunk({ type: 'IHDR', data: header }),
    chunk({ type: 'IDAT', data: new Uint8Array(deflateSync(raw)) }),
    chunk({ type: 'IEND', data: new Uint8Array(0) }),
  ]

  const out = new Uint8Array(pieces.reduce((total, piece) => total + piece.byteLength, 0))
  let at = 0
  for (const piece of pieces) {
    out.set(piece, at)
    at += piece.byteLength
  }

  return out
}

export function cropRaster({
  image,
  region,
}: {
  image: RasterImage
  region: ImageRegion
}): RasterImage {
  const { channels, size } = image
  const stride = size.width * channels
  const out = new Uint8Array(region.width * channels * region.height)

  for (let row = 0; row < region.height; row += 1) {
    const from = (region.y + row) * stride + region.x * channels
    out.set(
      image.pixels.subarray(from, from + region.width * channels),
      row * region.width * channels,
    )
  }

  return { size: { width: region.width, height: region.height }, channels, pixels: out }
}
