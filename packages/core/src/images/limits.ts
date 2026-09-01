import {
  EImageTier,
  projectedSize,
  projectedTokens,
  TIER_LIMITS,
  type ImageSize,
} from './projection'

export type { ImageSize }

export type ImageFacts = {
  byteLength: number
  width?: number | undefined
  height?: number | undefined
  tier?: EImageTier | undefined
}

export enum EImageDelivery {
  Inline = 'inline',
  PathOnly = 'path-only',
}

export type DeliveryPlan = {
  delivery: EImageDelivery
  resizeTo?: number
  reason?: string
}

export const MAX_LONG_EDGE = TIER_LIMITS[EImageTier.HighResolution].maxEdge

/** The API's ceiling is 10 MB of base64, which inflates raw bytes by a third. */
export const MAX_INLINE_BYTES = 5 * 1024 * 1024

/** Past this on either edge the API rejects the image outright rather than downscaling it. */
export const MAX_API_EDGE = 8000

const megabytes = (bytes: number): string => `${(bytes / 1024 / 1024).toFixed(1)} MB`

export const fitted = (size: ImageSize, tier?: EImageTier): ImageSize =>
  projectedSize({ size, tier })

export function visualTokens(facts: ImageFacts): number | null {
  if (facts.width === undefined || facts.height === undefined) return null

  return projectedTokens({
    size: { width: facts.width, height: facts.height },
    tier: facts.tier,
  })
}

export function planDelivery(facts: ImageFacts): DeliveryPlan {
  const longEdge = Math.max(facts.width ?? 0, facts.height ?? 0)

  if (longEdge > MAX_LONG_EDGE) return { delivery: EImageDelivery.Inline, resizeTo: MAX_LONG_EDGE }

  if (facts.byteLength > MAX_INLINE_BYTES) {
    return {
      delivery: EImageDelivery.PathOnly,
      reason: `${megabytes(facts.byteLength)} is past the ${megabytes(MAX_INLINE_BYTES)} inline limit`,
    }
  }

  return { delivery: EImageDelivery.Inline }
}

/**
 * What a caller that cannot resize should do. Sending a picture whole costs exactly the tokens
 * resizing it would have — `visualTokens` counts patches of `fitted`, not of the bytes on the wire —
 * so the long edge is no reason to withhold it, and only the ceilings the API truly enforces are.
 */
export function planUnresizedDelivery(facts: ImageFacts): DeliveryPlan {
  const longEdge = Math.max(facts.width ?? 0, facts.height ?? 0)

  if (longEdge > MAX_API_EDGE) {
    return {
      delivery: EImageDelivery.PathOnly,
      reason: `its ${longEdge} pixel long edge is past the ${MAX_API_EDGE} the API accepts`,
    }
  }

  if (facts.byteLength > MAX_INLINE_BYTES) {
    return {
      delivery: EImageDelivery.PathOnly,
      reason: `${megabytes(facts.byteLength)} is past the ${megabytes(MAX_INLINE_BYTES)} inline limit`,
    }
  }

  return { delivery: EImageDelivery.Inline }
}

const readUint32BE = (bytes: Uint8Array, offset: number): number =>
  ((bytes[offset] ?? 0) << 24) | ((bytes[offset + 1] ?? 0) << 16) | ((bytes[offset + 2] ?? 0) << 8) | (bytes[offset + 3] ?? 0)

const readUint16BE = (bytes: Uint8Array, offset: number): number => ((bytes[offset] ?? 0) << 8) | (bytes[offset + 1] ?? 0)

const readUint16LE = (bytes: Uint8Array, offset: number): number => (bytes[offset] ?? 0) | ((bytes[offset + 1] ?? 0) << 8)

const readUint24LE = (bytes: Uint8Array, offset: number): number =>
  (bytes[offset] ?? 0) | ((bytes[offset + 1] ?? 0) << 8) | ((bytes[offset + 2] ?? 0) << 16)

const startsWith = (bytes: Uint8Array, signature: readonly number[]): boolean =>
  bytes.length >= signature.length && signature.every((byte, index) => bytes[index] === byte)

const ascii = (bytes: Uint8Array, offset: number, length: number): string =>
  String.fromCharCode(...bytes.slice(offset, offset + length))

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]

/** IHDR is mandatory and always the first chunk, so width and height sit at fixed offsets. */
export function pngSize(bytes: Uint8Array): ImageSize | null {
  if (bytes.byteLength < 24) return null
  if (!startsWith(bytes, PNG_SIGNATURE)) return null
  if (ascii(bytes, 12, 4) !== 'IHDR') return null

  return { width: readUint32BE(bytes, 16), height: readUint32BE(bytes, 20) }
}

const JPEG_SIZE_MARKERS = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf])

/** Dimensions live in whichever SOFn frame header appears first; every other segment is skipped. */
export function jpegSize(bytes: Uint8Array): ImageSize | null {
  if (bytes.byteLength < 4) return null
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) return null

  let offset = 2
  while (offset + 9 < bytes.byteLength) {
    if (bytes[offset] !== 0xff) {
      offset += 1
      continue
    }

    const marker = bytes[offset + 1] ?? 0
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset += 2
      continue
    }
    if (marker === 0xd9 || marker === 0xda) return null

    const segmentLength = readUint16BE(bytes, offset + 2)
    if (segmentLength < 2) return null

    if (JPEG_SIZE_MARKERS.has(marker)) {
      return { width: readUint16BE(bytes, offset + 7), height: readUint16BE(bytes, offset + 5) }
    }

    offset += 2 + segmentLength
  }

  return null
}

export function gifSize(bytes: Uint8Array): ImageSize | null {
  if (bytes.byteLength < 10) return null
  if (ascii(bytes, 0, 6) !== 'GIF87a' && ascii(bytes, 0, 6) !== 'GIF89a') return null

  return { width: readUint16LE(bytes, 6), height: readUint16LE(bytes, 8) }
}

/** RIFF container, then one of three chunk layouts, each storing the size differently. */
export function webpSize(bytes: Uint8Array): ImageSize | null {
  if (bytes.byteLength < 30) return null
  if (ascii(bytes, 0, 4) !== 'RIFF' || ascii(bytes, 8, 4) !== 'WEBP') return null

  const chunk = ascii(bytes, 12, 4)

  if (chunk === 'VP8 ') {
    return { width: readUint16LE(bytes, 26) & 0x3fff, height: readUint16LE(bytes, 28) & 0x3fff }
  }

  if (chunk === 'VP8L') {
    const packed = readUint32BE(bytes, 21)
    const bits = ((packed >>> 24) & 0xff) | (((packed >>> 16) & 0xff) << 8) | (((packed >>> 8) & 0xff) << 16) | ((packed & 0xff) << 24)
    return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 }
  }

  if (chunk === 'VP8X') {
    return { width: readUint24LE(bytes, 24) + 1, height: readUint24LE(bytes, 27) + 1 }
  }

  return null
}

export const SUPPORTED_IMAGE_MEDIA_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'] as const

export type SupportedImageMediaType = (typeof SUPPORTED_IMAGE_MEDIA_TYPES)[number]

export function imageMediaType(bytes: Uint8Array): SupportedImageMediaType | null {
  if (pngSize(bytes)) return 'image/png'
  if (jpegSize(bytes)) return 'image/jpeg'
  if (gifSize(bytes)) return 'image/gif'
  if (webpSize(bytes)) return 'image/webp'
  return null
}

const BASE64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

const BASE64_VALUES = new Map([...BASE64_ALPHABET].map((character, index) => [character, index]))

export function decodeBase64(text: string): Uint8Array {
  const digits: number[] = []
  for (const character of text) {
    const value = BASE64_VALUES.get(character)
    if (value !== undefined) digits.push(value)
  }

  const bytes = new Uint8Array(Math.floor((digits.length * 6) / 8))
  let accumulator = 0
  let bitsHeld = 0
  let written = 0

  for (const digit of digits) {
    accumulator = (accumulator << 6) | digit
    bitsHeld += 6
    if (bitsHeld < 8) continue

    bitsHeld -= 8
    bytes[written] = (accumulator >> bitsHeld) & 0xff
    written += 1
  }

  return bytes
}

export function imageSize(args: { bytes: Uint8Array; mediaType: string }): ImageSize | null {
  if (args.mediaType === 'image/png') return pngSize(args.bytes)
  if (args.mediaType === 'image/jpeg') return jpegSize(args.bytes)
  if (args.mediaType === 'image/gif') return gifSize(args.bytes)
  if (args.mediaType === 'image/webp') return webpSize(args.bytes)
  return null
}
