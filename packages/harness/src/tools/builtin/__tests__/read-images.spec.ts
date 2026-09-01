import {
  decodeBase64,
  MAX_API_EDGE,
  MAX_INLINE_BYTES,
  toThreadId,
  type ToolOutcome,
} from '@dltech/atlas-core'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeAll, describe, expect, it } from 'bun:test'

import { decodePng, encodePng } from '../../../images/png'
import { ReadTool } from '../read'
import type { ImageReadOutput } from '../read-image'

const bigEndian32 = (value: number): number[] => [
  (value >> 24) & 0xff,
  (value >> 16) & 0xff,
  (value >> 8) & 0xff,
  value & 0xff,
]

const png = (args: { width: number; height: number; padding?: number }): Uint8Array =>
  new Uint8Array([
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
    ...bigEndian32(args.width),
    ...bigEndian32(args.height),
    ...Array.from({ length: args.padding ?? 0 }, (_, index) => index % 251),
  ])

const QUADRANT_COLOURS = {
  topLeft: [255, 0, 0],
  topRight: [0, 255, 0],
  bottomLeft: [0, 0, 255],
  bottomRight: [255, 255, 0],
} as const

function quadrantPng(edge: number): Uint8Array {
  const pixels = new Uint8Array(edge * edge * 3)

  for (let y = 0; y < edge; y += 1) {
    for (let x = 0; x < edge; x += 1) {
      const left = x < edge / 2
      const top = y < edge / 2
      const colour = top
        ? left
          ? QUADRANT_COLOURS.topLeft
          : QUADRANT_COLOURS.topRight
        : left
          ? QUADRANT_COLOURS.bottomLeft
          : QUADRANT_COLOURS.bottomRight
      pixels.set(colour, (y * edge + x) * 3)
    }
  }

  return encodePng({ size: { width: edge, height: edge }, channels: 3, pixels })
}

let root = ''

const paths = {
  small: '',
  wide: '',
  enormous: '',
  heavy: '',
  text: '',
  misnamed: '',
  quadrants: '',
}

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'atlas-read-images-'))

  paths.small = join(root, 'shot.png')
  paths.wide = join(root, 'retina.png')
  paths.enormous = join(root, 'enormous.png')
  paths.heavy = join(root, 'huge.png')
  paths.text = join(root, 'notes.txt')
  paths.misnamed = join(root, 'not-really.txt')
  paths.quadrants = join(root, 'quadrants.png')

  await writeFile(paths.small, png({ width: 1024, height: 768, padding: 400 * 1024 }))
  await writeFile(paths.wide, png({ width: 4000, height: 3000 }))
  await writeFile(paths.enormous, png({ width: MAX_API_EDGE + 1, height: 100 }))
  await writeFile(paths.heavy, png({ width: 800, height: 600, padding: MAX_INLINE_BYTES + 1 }))
  await writeFile(paths.text, 'alpha\nbravo\n')
  await writeFile(paths.misnamed, png({ width: 32, height: 16 }))
  await writeFile(paths.quadrants, quadrantPng(400))
})

const tool = new ReadTool()

const read = async (
  path: string,
  region?: { x: number; y: number; width: number; height: number },
): Promise<ToolOutcome> =>
  await tool.invoke({
    input: { path, ...(region === undefined ? {} : { region }) },
    signal: new AbortController().signal,
    idempotencyKey: 'read-images',
    projectDirectory: '/workspace',
    threadId: toThreadId('thread-1'),
  })

const settled = async (path: string) => {
  const outcome = await read(path)
  if (!outcome.ok) throw new Error(outcome.reason)
  return outcome
}

const imageOutput = (output: unknown): ImageReadOutput => output as ImageReadOutput

describe('read on an image', () => {
  it('returns a text part naming the file and an image part carrying its bytes', async () => {
    const outcome = await settled(paths.small)

    expect(outcome.modelParts).toEqual([
      { type: 'text', text: `${paths.small} — image/png, 1024×768, 400 KB.` },
      {
        type: 'image',
        data: expect.any(String),
        mediaType: 'image/png',
        source: paths.small,
        width: 1024,
        height: 768,
      },
    ])

    const part = outcome.modelParts?.[1]
    if (part === undefined || part.type !== 'image') throw new Error('expected an image part')
    expect(decodeBase64(part.data).byteLength).toBe(400 * 1024 + 24)
  })

  it('reports the picture rather than a line count', async () => {
    const output = imageOutput((await settled(paths.small)).output)

    expect(output).toEqual({
      path: paths.small,
      mediaType: 'image/png',
      byteLength: 400 * 1024 + 24,
      width: 1024,
      height: 768,
      inlined: true,
    })
  })

  it('does not claim a whole-file reveal, so an image read cannot unlock an edit', async () => {
    const outcome = await settled(paths.small)

    expect(tool.revealsWholeFile?.({ input: { path: paths.small }, output: outcome.output })).toBe(
      false,
    )
  })

  it('sniffs the bytes, not the extension', async () => {
    const outcome = await settled(paths.misnamed)

    expect(imageOutput(outcome.output).mediaType).toBe('image/png')
    expect(outcome.modelParts).toHaveLength(2)
  })
})

describe('read on an image past the long edge', () => {
  it('sends it whole, because the API downscales what it will not read at full size', async () => {
    const outcome = await settled(paths.wide)

    expect(outcome.modelText).toBe(`${paths.wide} — image/png, 4000×3000, 24 B.`)
    expect(outcome.modelParts).toHaveLength(2)
    expect(imageOutput(outcome.output).inlined).toBe(true)
  })
})

describe('read on an image it cannot send', () => {
  it('declines past the edge the API refuses outright', async () => {
    const outcome = await settled(paths.enormous)

    expect(outcome.modelParts).toBeUndefined()
    expect(outcome.modelText).toContain(`past the ${MAX_API_EDGE} the API accepts`)
    expect(imageOutput(outcome.output).inlined).toBe(false)
  })

  it('gives the size as the reason when the file is past the inline ceiling', async () => {
    const outcome = await settled(paths.heavy)

    expect(outcome.modelParts).toBeUndefined()
    expect(outcome.modelText).toContain('is past the 5.0 MB inline limit')
    expect(imageOutput(outcome.output)).toMatchObject({
      width: 800,
      height: 600,
      inlined: false,
    })
  })
})

describe('read on a text file', () => {
  it('is unchanged', async () => {
    const outcome = await settled(paths.text)

    expect(outcome.modelParts).toBeUndefined()
    expect(outcome.modelText).toBe('1\talpha\n2\tbravo')
    expect(outcome.output).toEqual({ path: paths.text, lines: 2, truncated: false })
  })

  it('still turns away a binary file that is not an image', async () => {
    const path = join(root, 'blob.bin')
    await writeFile(path, new Uint8Array([0x7f, 0x45, 0x4c, 0x46, 0x00, 0x01, 0x02]))

    const outcome = await read(path)

    expect(outcome).toEqual({
      ok: false,
      reason: `${path} looks like a binary file and cannot be read as text.`,
    })
  })
})

describe('read on one region of an image', () => {
  const centreColourOf = (outcome: ToolOutcome): string => {
    const part = outcome.ok ? outcome.modelParts?.[1] : undefined
    if (part === undefined || part.type !== 'image') throw new Error('expected an image part')

    const image = decodePng(decodeBase64(part.data))
    if (image === null) throw new Error('expected a readable png')

    const x = image.size.width >> 1
    const y = image.size.height >> 1
    const at = (y * image.size.width + x) * image.channels

    return [...image.pixels.subarray(at, at + 3)].join(',')
  }

  it('sends only the pane asked for, at the resolution it already had', async () => {
    const outcome = await read(paths.quadrants, { x: 200, y: 0, width: 200, height: 200 })
    if (!outcome.ok) throw new Error(outcome.reason)

    expect(centreColourOf(outcome)).toBe('0,255,0')
    expect(imageOutput(outcome.output)).toMatchObject({ width: 200, height: 200, inlined: true })
  })

  it('cuts the bottom-left pane, the corner a shell-out to sips silently refused', async () => {
    const outcome = await read(paths.quadrants, { x: 0, y: 200, width: 200, height: 200 })
    if (!outcome.ok) throw new Error(outcome.reason)

    expect(centreColourOf(outcome)).toBe('0,0,255')
  })

  it('tells the model what the crop saved, so it can judge whether to crop again', async () => {
    const outcome = await read(paths.quadrants, { x: 0, y: 0, width: 200, height: 200 })
    if (!outcome.ok) throw new Error(outcome.reason)

    expect(outcome.modelText).toContain('64 visual tokens')
    expect(outcome.modelText).toContain('225 for the whole 400×400 image')
  })

  it('trims a region that overhangs and says it did', async () => {
    const outcome = await read(paths.quadrants, { x: 300, y: 300, width: 500, height: 500 })
    if (!outcome.ok) throw new Error(outcome.reason)

    expect(outcome.modelText).toContain('trimmed to fit the image')
    expect(imageOutput(outcome.output)).toMatchObject({ width: 100, height: 100 })
  })

  it('refuses an origin outside the picture instead of returning something else', async () => {
    const outcome = await read(paths.quadrants, { x: 900, y: 0, width: 10, height: 10 })

    expect(outcome.ok).toBe(false)
    expect(!outcome.ok && outcome.reason).toContain('past the right edge')
  })

  it('says region does not apply to a text file rather than ignoring it', async () => {
    const outcome = await read(paths.text, { x: 0, y: 0, width: 10, height: 10 })

    expect(outcome.ok).toBe(false)
    expect(!outcome.ok && outcome.reason).toContain('not an image')
  })
})
