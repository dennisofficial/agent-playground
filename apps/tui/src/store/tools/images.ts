import type { ToolCall } from '../tool-runs'
import { EDetail, EGather, EToolClass, type Classification } from './kinds'
import { num, outputOf, relativise, str } from './reading'

export type ReadImage = {
  path: string
  mediaType: string
  width: number | null
  height: number | null
  byteLength: number | null
}

export function imageOf(call: ToolCall): ReadImage | null {
  const output = outputOf(call)
  const mediaType = str(output.mediaType)
  const path = str(output.path)
  if (mediaType === undefined || path === undefined) return null
  if (!mediaType.startsWith('image/')) return null

  return {
    path,
    mediaType,
    width: num(output.width) ?? null,
    height: num(output.height) ?? null,
    byteLength: num(output.byteLength) ?? null,
  }
}

const KILOBYTE = 1024

export function humanBytes(byteLength: number): string {
  if (byteLength < KILOBYTE) return `${byteLength} B`
  if (byteLength < KILOBYTE * KILOBYTE) return `${Math.round(byteLength / KILOBYTE)} KB`
  return `${(byteLength / KILOBYTE / KILOBYTE).toFixed(1)} MB`
}

const dimensionsOf = (image: ReadImage): string | null =>
  image.width === null || image.height === null ? null : `${image.width}×${image.height}`

const SEPARATOR = ' · '

export function imageSummary(args: { call: ToolCall; cwd: string }): string | null {
  const image = imageOf(args.call)
  if (image === null) return null

  const parts = [
    relativise(image.path, args.cwd),
    dimensionsOf(image),
    image.byteLength === null ? null : humanBytes(image.byteLength),
  ]

  return parts.filter((part): part is string => part !== null).join(SEPARATOR)
}

export function imageRead(args: { call: ToolCall; cwd: string }): Classification | null {
  const image = imageOf(args.call)
  if (image === null) return null

  const path = relativise(image.path, args.cwd)
  const measure =
    dimensionsOf(image) ?? (image.byteLength === null ? '' : humanBytes(image.byteLength))

  return {
    klass: EToolClass.Gathered,
    gather: EGather.Read,
    line: path,
    alone: `Read ${path}`,
    failed: false,
    note: measure,
    metric: null,
    detail: EDetail.Image,
  }
}
