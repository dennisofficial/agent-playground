import {
  base64Bytes,
  EImageDelivery,
  imagePathLine,
  imageTagOrdinals,
  replaceImageTag,
  visualTokens,
  type SaidImage,
} from '@dltech/atlas-core'

import type { ClipboardImage } from './clipboard-image'

export type DraftImage = ClipboardImage & { ordinal: number }

export const noDraftImages: readonly DraftImage[] = Object.freeze([])

/**
 * `max + 1` rather than `length + 1`: a tag the operator deleted must not have its number handed to
 * the next paste, or the prose above it starts pointing at a different picture.
 */
const nextOrdinal = (images: readonly DraftImage[]): number =>
  images.reduce((highest, image) => Math.max(highest, image.ordinal), 0) + 1

export function attachImage(args: {
  images: readonly DraftImage[]
  image: ClipboardImage
}): readonly DraftImage[] {
  return [...args.images, { ...args.image, ordinal: nextOrdinal(args.images) }]
}

/**
 * The pictures the draft still refers to, in the order it refers to them. Held images the text has
 * stopped naming are simply gone — backspacing the tag is how a picture is taken back off.
 */
export function keptImages(args: {
  images: readonly DraftImage[]
  text: string
}): readonly DraftImage[] {
  const held = new Map(args.images.map((image) => [image.ordinal, image]))

  return imageTagOrdinals(args.text)
    .map((ordinal) => held.get(ordinal))
    .filter((image): image is DraftImage => image !== undefined)
}

export function restoredImages(args: {
  images: readonly SaidImage[]
  text: string
}): readonly DraftImage[] {
  const ordinals = imageTagOrdinals(args.text)

  return args.images.map((image, index) => ({
    ordinal: ordinals[index] ?? index + 1,
    path: image.path,
    mediaType: image.mediaType,
    byteLength: base64Bytes(image.data),
    width: image.width,
    height: image.height,
    delivery: EImageDelivery.Inline,
    tokens: visualTokens({ byteLength: base64Bytes(image.data), ...image }),
  }))
}

export type Submission = { text: string; images: readonly SaidImage[] }

/**
 * What the draft becomes on send. An inline picture rides the message as an `ImagePart` and keeps
 * its tag, so the prose around it still names something the model was shown. Anything too heavy to
 * inline — or anything whose bytes have gone missing since the paste — has its tag swapped in place
 * for the path, so the agent can `read` it for itself rather than the picture vanishing silently.
 */
export function submissionOf(args: {
  text: string
  images: readonly DraftImage[]
  load: (path: string) => string | null
}): Submission {
  const inline: SaidImage[] = []
  let text = args.text

  for (const image of keptImages({ images: args.images, text: args.text })) {
    const data = image.delivery === EImageDelivery.Inline ? args.load(image.path) : null

    if (data === null) {
      text = replaceImageTag({ text, ordinal: image.ordinal, replacement: imagePathLine(image) })
      continue
    }

    inline.push({
      path: image.path,
      mediaType: image.mediaType,
      data,
      ...(image.width === undefined ? {} : { width: image.width }),
      ...(image.height === undefined ? {} : { height: image.height }),
    })
  }

  return { text: text.trim(), images: inline }
}
