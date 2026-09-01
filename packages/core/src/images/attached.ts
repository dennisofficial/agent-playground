import { EImageDelivery, planDelivery } from './limits'

export type ImageOnDisk = {
  path: string
  width?: number | undefined
  height?: number | undefined
}

/** Base64 carries three bytes in every four characters, padding aside. */
export const base64Bytes = (data: string): number => Math.floor((data.length * 3) / 4)

/**
 * How an image the model cannot be shown is named to it instead. One spelling, because the composer
 * writes it at submit for a picture it never inlined and assembly writes it again for one that turns
 * out to be too heavy — and the agent has to recognise the same thing in both.
 */
export const imagePathLine = (image: ImageOnDisk): string =>
  image.width === undefined || image.height === undefined
    ? `[image ${image.path}]`
    : `[image ${image.path} · ${image.width}×${image.height}]`

export const inlinable = (image: ImageOnDisk & { data: string }): boolean =>
  planDelivery({
    byteLength: base64Bytes(image.data),
    width: image.width,
    height: image.height,
  }).delivery === EImageDelivery.Inline

/**
 * The tag the composer writes into the draft where a picture was pasted, and the only record that
 * the picture is attached at all. Deleting the tag detaches the image, and moving it moves the
 * image, because the text is read back at submit rather than a side list being trusted.
 */
export const imageTag = (ordinal: number): string => `[Image #${ordinal}]`

const IMAGE_TAG = /\[Image #(\d+)\]/g

export type ImageTagSpan = { start: number; end: number; ordinal: number }

/** Every occurrence, because each one is separately paintable and separately deletable. */
export function imageTagSpans(text: string): readonly ImageTagSpan[] {
  const spans: ImageTagSpan[] = []

  for (const match of text.matchAll(IMAGE_TAG)) {
    if (match.index === undefined) continue
    spans.push({ start: match.index, end: match.index + match[0].length, ordinal: Number(match[1]) })
  }

  return spans
}

/**
 * A second tag naming a picture already read is a copy of the label, not a second picture, so the
 * ordinal is taken once — at the position the draft first refers to it.
 */
export function imageTagOrdinals(text: string): readonly number[] {
  const seen = new Set<number>()

  return imageTagSpans(text)
    .map((span) => span.ordinal)
    .filter((ordinal) => (seen.has(ordinal) ? false : (seen.add(ordinal), true)))
}

/**
 * The tag the cursor has ended up inside. Motion over a tag is the editor's own business, but a
 * mouse click sets the caret by row and column rather than by offset, so it lands wherever it was
 * clicked — inside the tag included. The position is corrected afterwards rather than the click
 * being intercepted.
 */
export const imageTagAround = (args: { text: string; offset: number }): ImageTagSpan | null =>
  imageTagSpans(args.text).find((span) => span.start < args.offset && args.offset < span.end) ?? null

/** The near edge, so a caret dropped into a tag leaves by the side it was closest to. */
export const nearerEdgeOf = (args: { span: ImageTagSpan; offset: number }): number =>
  args.offset - args.span.start < args.span.end - args.offset ? args.span.start : args.span.end

export const replaceImageTag = (args: {
  text: string
  ordinal: number
  replacement: string
}): string => args.text.split(imageTag(args.ordinal)).join(args.replacement)
