import { deflateSync } from 'node:zlib'

const CRC_TABLE = Array.from({ length: 256 }, (_unused, index) => {
  let value = index
  for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
  return value >>> 0
})

const crc32 = (bytes: Uint8Array): number => {
  let value = 0xffffffff
  for (const byte of bytes) value = (CRC_TABLE[(value ^ byte) & 0xff] ?? 0) ^ (value >>> 8)
  return (value ^ 0xffffffff) >>> 0
}

const join = (parts: readonly Uint8Array[]): Uint8Array => {
  const total = parts.reduce((sum, part) => sum + part.length, 0)
  const out = new Uint8Array(total)
  let at = 0
  for (const part of parts) {
    out.set(part, at)
    at += part.length
  }
  return out
}

const uint32BE = (value: number): Uint8Array =>
  new Uint8Array([(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff])

const chunk = (type: string, data: Uint8Array): Uint8Array => {
  const body = join([new Uint8Array([...type].map((c) => c.charCodeAt(0))), data])
  return join([uint32BE(data.length), body, uint32BE(crc32(body))])
}

const PNG_SIGNATURE = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

/** IDAT is a zlib stream (RFC 1950). Bun.deflateSync emits raw DEFLATE and produces an invalid PNG. */
export function encodePng(args: {
  width: number
  height: number
  colourType: number
  samples: Uint8Array
  bytesPerPixel: number
}): Uint8Array {
  const stride = args.width * args.bytesPerPixel
  const filtered = new Uint8Array(args.height * (1 + stride))

  for (let row = 0; row < args.height; row += 1) {
    filtered[row * (1 + stride)] = 0
    filtered.set(args.samples.subarray(row * stride, (row + 1) * stride), row * (1 + stride) + 1)
  }

  const header = join([
    uint32BE(args.width),
    uint32BE(args.height),
    new Uint8Array([8, args.colourType, 0, 0, 0]),
  ])

  return join([
    PNG_SIGNATURE,
    chunk('IHDR', header),
    chunk('IDAT', new Uint8Array(deflateSync(filtered))),
    chunk('IEND', new Uint8Array(0)),
  ])
}
