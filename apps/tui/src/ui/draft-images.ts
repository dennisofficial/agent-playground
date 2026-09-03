import {
  base64Bytes,
  EImageDelivery,
  imagePathLine,
  imageTagOrdinals,
  visualTokens,
  type SaidImage,
} from '@dltech/atlas-core'

import type { ClipboardImage } from './clipboard-image'
import type { LiveToken } from './composer-tokens'

export type DraftImage = ClipboardImage & { ordinal: number }

export const noDraftImages: readonly DraftImage[] = Object.freeze([])

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
 * What the draft becomes on send, read straight off the extmarks the registry wrote. Every span is
 * spliced right to left, so earlier tokens keep their offsets while a pasted block expands or an
 * image too heavy to inline swaps its tag for the path. An unsettled image keeps its tag; a settled
 * one carries its picture.
 */
export function submissionOf(args: {
  text: string
  tokens: readonly LiveToken[]
  load: (path: string) => string | null
}): Submission {
  let text = args.text
  const inline: SaidImage[] = []

  for (const token of [...args.tokens].sort((a, b) => b.start - a.start)) {
    const { slot } = token

    if (slot.kind === 'pasted') {
      text = text.slice(0, token.start) + slot.content + text.slice(token.end)
      continue
    }

    if (slot.image === null) continue

    const data = slot.image.delivery === EImageDelivery.Inline ? args.load(slot.image.path) : null

    if (data === null) {
      text = text.slice(0, token.start) + imagePathLine(slot.image) + text.slice(token.end)
      continue
    }

    inline.push({
      path: slot.image.path,
      mediaType: slot.image.mediaType,
      data,
      ...(slot.image.width === undefined ? {} : { width: slot.image.width }),
      ...(slot.image.height === undefined ? {} : { height: slot.image.height }),
    })
  }

  return { text: text.trim(), images: inline }
}
