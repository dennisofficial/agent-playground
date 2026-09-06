import {
  EImageDelivery,
  imageSize,
  MAX_INLINE_BYTES,
  planDelivery,
  type FileSystemPort,
  type ImageSize,
  type ModelPart,
  type SupportedImageMediaType,
  type ToolOutcome,
} from '@dltech/atlas-core'

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

export async function readImage(args: {
  path: string
  mediaType: SupportedImageMediaType
  byteLength: number
  head: Uint8Array
  files: FileSystemPort
}): Promise<ToolOutcome> {
  const { path, mediaType, byteLength } = args

  const readable =
    byteLength <= MAX_INLINE_BYTES ? await args.files.readBytes({ path }) : args.head

  const size = imageSize({ bytes: readable, mediaType })

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
