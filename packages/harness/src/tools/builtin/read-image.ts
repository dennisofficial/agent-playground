import {
  EImageDelivery,
  imageSize,
  MAX_INLINE_BYTES,
  planDelivery,
  planRegion,
  regionSaving,
  type ImageRegion,
  type ImageSize,
  type ModelPart,
  type SupportedImageMediaType,
  type ToolOutcome,
} from '@dltech/atlas-core'

import { croppedImage, isCropped } from '../../images/crop'

export type ImageReadOutput = {
  path: string
  mediaType: SupportedImageMediaType
  byteLength: number
  width?: number | undefined
  height?: number | undefined
  inlined: boolean
}

const KILOBYTE = 1024

export function humanBytes(byteLength: number): string {
  if (byteLength < KILOBYTE) return `${byteLength} B`
  if (byteLength < KILOBYTE * KILOBYTE) return `${Math.round(byteLength / KILOBYTE)} KB`
  return `${(byteLength / KILOBYTE / KILOBYTE).toFixed(1)} MB`
}

const dimensions = (size: ImageSize | null): string =>
  size === null ? 'unknown dimensions' : `${size.width}×${size.height}`

const describe = (args: {
  path: string
  mediaType: SupportedImageMediaType
  size: ImageSize | null
  byteLength: number
}): string =>
  `${args.path} — ${args.mediaType}, ${dimensions(args.size)}, ${humanBytes(args.byteLength)}.`

const outputFor = (args: {
  path: string
  mediaType: SupportedImageMediaType
  size: ImageSize | null
  byteLength: number
  inlined: boolean
}): ImageReadOutput => ({
  path: args.path,
  mediaType: args.mediaType,
  byteLength: args.byteLength,
  width: args.size?.width,
  height: args.size?.height,
  inlined: args.inlined,
})

const textOnly = (args: {
  path: string
  mediaType: SupportedImageMediaType
  size: ImageSize | null
  byteLength: number
  because: string
}): ToolOutcome => ({
  ok: true,
  output: outputFor({ ...args, inlined: false }),
  modelText: `${describe(args)} It was not sent to you because ${args.because}.`,
})

const inlined = (args: {
  path: string
  mediaType: SupportedImageMediaType
  size: ImageSize | null
  byteLength: number
  bytes: Uint8Array
}): ToolOutcome => {
  const summary = describe(args)
  const parts: readonly ModelPart[] = [
    { type: 'text', text: summary },
    {
      type: 'image',
      data: Buffer.from(args.bytes).toString('base64'),
      mediaType: args.mediaType,
      source: args.path,
      width: args.size?.width,
      height: args.size?.height,
    },
  ]

  return {
    ok: true,
    output: outputFor({ ...args, inlined: true }),
    modelText: summary,
    modelParts: parts,
  }
}

function croppedRead(args: {
  path: string
  region: ImageRegion
  size: ImageSize
  bytes: Uint8Array
  mediaType: SupportedImageMediaType
}): ToolOutcome {
  const plan = planRegion({ size: args.size, region: args.region })
  if (!plan.ok) return { ok: false, reason: `${args.path}: ${plan.reason}.` }

  const crop = croppedImage({ bytes: args.bytes, mediaType: args.mediaType, region: plan.region })
  if (!isCropped(crop)) {
    return { ok: false, reason: `${args.path} could not be cropped: ${crop.reason}.` }
  }

  const saving = regionSaving({ size: args.size, region: crop.size })
  const trimmed = plan.clamped ? ', trimmed to fit the image' : ''
  const summary =
    `${args.path} cropped to ${crop.size.width}×${crop.size.height} at ` +
    `(${plan.region.x}, ${plan.region.y})${trimmed} — ${saving.cropped} visual tokens ` +
    `against ${saving.whole} for the whole ${args.size.width}×${args.size.height} image.`

  return {
    ok: true,
    output: {
      path: args.path,
      mediaType: crop.mediaType,
      byteLength: crop.bytes.byteLength,
      width: crop.size.width,
      height: crop.size.height,
      inlined: true,
    } satisfies ImageReadOutput,
    modelText: summary,
    modelParts: [
      { type: 'text', text: summary },
      {
        type: 'image',
        data: Buffer.from(crop.bytes).toString('base64'),
        mediaType: crop.mediaType,
        source: args.path,
        width: crop.size.width,
        height: crop.size.height,
      },
    ],
  }
}

export async function readImage(args: {
  path: string
  mediaType: SupportedImageMediaType
  byteLength: number
  head: Uint8Array
  region?: ImageRegion | undefined
}): Promise<ToolOutcome> {
  const { path, mediaType, byteLength } = args

  const readable =
    byteLength <= MAX_INLINE_BYTES ? new Uint8Array(await Bun.file(path).arrayBuffer()) : args.head

  const size = imageSize({ bytes: readable, mediaType })

  if (args.region !== undefined) {
    if (size === null) {
      return { ok: false, reason: `${path} could not be measured, so a region cannot be cut from it.` }
    }
    return croppedRead({ path, region: args.region, size, bytes: readable, mediaType })
  }

  const plan = planDelivery({ byteLength, width: size?.width, height: size?.height })

  if (plan.delivery === EImageDelivery.PathOnly) {
    return textOnly({
      path,
      mediaType,
      size,
      byteLength,
      because: plan.reason ?? `${humanBytes(byteLength)} is too large to inline`,
    })
  }

  return inlined({ path, mediaType, size, byteLength, bytes: readable })
}
