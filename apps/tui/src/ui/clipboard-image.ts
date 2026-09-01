import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import {
  EImageDelivery,
  imageMediaType,
  imageSize,
  planDelivery,
  visualTokens,
  type SupportedImageMediaType,
} from '@dltech/atlas-core'

export type ClipboardImage = {
  path: string
  mediaType: string
  byteLength: number
  width?: number | undefined
  height?: number | undefined
  delivery: EImageDelivery
  tokens: number | null
  reason?: string | undefined
}

export type ClipboardImageReader = (args: { directory: string }) => Promise<ClipboardImage | null>

/** AppleScript renders raw clipboard data as `«data PNGf8950…»` — hex, not base64. */
const PNG_HEX = /«data PNGf([0-9A-Fa-f]+)»/

const EXTENSIONS: Record<SupportedImageMediaType, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
}

let pasted = 0

const pasteName = (extension: string): string => {
  pasted += 1
  return `paste-${Date.now()}-${pasted}.${extension}`
}

type NativeClipboard = { hasImage: () => boolean; getImageBase64: () => Promise<string> }

let native: NativeClipboard | null | undefined

/**
 * Reads the system pasteboard in-process. A required dependency — a build that cannot resolve it
 * should fail loudly rather than ship a binary that quietly takes the slow door. The guard is for
 * the narrower case of a compiled binary meeting an architecture whose prebuilt was not the one
 * embedded, where degrading beats refusing to paste.
 */
async function nativeClipboard(): Promise<NativeClipboard | null> {
  if (native !== undefined) return native

  try {
    const loaded = await import('@mariozechner/clipboard')
    native = typeof loaded.hasImage === 'function' ? loaded : null
  } catch {
    native = null
  }

  return native
}

/**
 * Measured on an M-series machine against a 13.7 MB picture: `hasImage` answers in under a
 * millisecond warm and `getImageBase64` in 63 ms, where asking AppleScript for the same bytes takes
 * 1047 ms. That ratio is the whole reason the dependency is here — the tag has to land before the
 * paste keystroke is released, and no arrangement of a spawned `osascript` gets close.
 */
async function clipboardBytes(): Promise<Buffer | null> {
  const clipboard = await nativeClipboard()
  if (clipboard !== null) {
    if (!clipboard.hasImage()) return null
    return Buffer.from(await clipboard.getImageBase64(), 'base64')
  }

  return await appleScriptClipboardBytes()
}

/**
 * The fallback, for a machine the native module would not install on. The non-zero exit IS the
 * "is there an image?" test: `osascript` refuses the coercion for text, for an empty clipboard and
 * for a file promise alike, and none of those is an error worth reporting.
 */
export async function appleScriptClipboardBytes(): Promise<Buffer | null> {
  if (process.platform !== 'darwin') return null

  const read = Bun.spawn(['osascript', '-e', 'the clipboard as «class PNGf»'], {
    stdout: 'pipe',
    stderr: 'ignore',
  })
  const [stdout, exitCode] = await Promise.all([new Response(read.stdout).text(), read.exited])
  if (exitCode !== 0) return null

  const match = PNG_HEX.exec(stdout)
  return match?.[1] === undefined ? null : Buffer.from(match[1], 'hex')
}

/**
 * An image cannot arrive through the paste channel. Bracketed paste is TEXT: OpenTUI's
 * `PasteMetadata` declares a `mimeType` and a `binary` kind but nothing populates them, and
 * `pbpaste` returns the empty string when the clipboard holds a picture. So the image is PULLED —
 * either on ctrl+v, or on the empty paste a terminal makes of a picture, which is the same signal
 * arriving by a different door.
 */
export const readClipboardImage: ClipboardImageReader = async ({ directory }) =>
  await attachClipboardImage({ directory, pull: clipboardBytes, memory: oneGesture })

async function writtenClipboardImage(args: {
  directory: string
  bytes: Buffer | null
}): Promise<ClipboardImage | null> {
  const { directory, bytes } = args
  if (bytes === null) return null

  const mediaType = imageMediaType(bytes)
  if (mediaType === null) return null

  const size = imageSize({ bytes, mediaType })
  if (size === null) return null

  const path = join(directory, pasteName(EXTENSIONS[mediaType]))
  mkdirSync(directory, { recursive: true })
  writeFileSync(path, bytes)

  const planned = planDelivery({ byteLength: bytes.byteLength, ...size })
  const shrunk =
    planned.resizeTo === undefined
      ? null
      : await shrink({ path, mediaType, longEdge: planned.resizeTo })
  const facts = shrunk ?? { byteLength: bytes.byteLength, ...size }

  const settled = planDelivery(facts)

  return {
    path,
    mediaType,
    byteLength: facts.byteLength,
    width: facts.width,
    height: facts.height,
    delivery: settled.delivery,
    tokens: visualTokens(facts),
    ...(settled.reason === undefined ? {} : { reason: settled.reason }),
  }
}

const oneGesture: PasteMemory = { written: new Map() }

export type PasteMemory = { written: Map<string, { digest: string; image: ClipboardImage }> }

export const newPasteMemory = (): PasteMemory => ({ written: new Map() })

const digestOf = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex')

/**
 * One gesture can open both paste doors — a terminal that hands the application ctrl+v *and* makes
 * an empty paste of the picture asks twice for the same bytes. Remembering what was last written to
 * a directory keeps that one keystroke to one file and one tag, while a genuinely new picture, or
 * the same picture in another conversation, still gets a copy of its own.
 */
export async function attachClipboardImage(args: {
  directory: string
  pull: () => Promise<Buffer | null>
  memory: PasteMemory
}): Promise<ClipboardImage | null> {
  const bytes = await args.pull()
  if (bytes === null) return null

  const digest = digestOf(bytes)
  const known = args.memory.written.get(args.directory)
  if (known !== undefined && known.digest === digest) return known.image

  const image = await writtenClipboardImage({ directory: args.directory, bytes })
  if (image === null) return null

  args.memory.written.set(args.directory, { digest, image })
  return image
}

/**
 * `sips` ships with macOS, the same reason the fallback read is an `osascript` call. A failure is
 * not fatal: the original is still on disk and still sendable, so the caller keeps what it had.
 */
async function shrink(args: {
  path: string
  mediaType: SupportedImageMediaType
  longEdge: number
}): Promise<{ byteLength: number; width: number; height: number } | null> {
  const resized = Bun.spawn(['sips', '-Z', String(args.longEdge), args.path], {
    stdout: 'ignore',
    stderr: 'ignore',
  })
  if ((await resized.exited) !== 0) return null

  const bytes = readFileSync(args.path)
  const size = imageSize({ bytes, mediaType: args.mediaType })
  if (size === null) return null

  return { byteLength: bytes.byteLength, ...size }
}

export function readImageBase64(path: string): string | null {
  try {
    return readFileSync(path).toString('base64')
  } catch {
    return null
  }
}
