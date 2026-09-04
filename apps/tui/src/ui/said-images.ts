import { base64Bytes, visualTokens, type SaidImage } from '@dltech/atlas-core'

import { formatTokens } from './theme'

const basename = (path: string): string => path.slice(path.lastIndexOf('/') + 1)

const sized = (image: SaidImage): string | null =>
  image.width === undefined || image.height === undefined ? null : `${image.width}×${image.height}`

const cost = (image: SaidImage): string | null => {
  const tokens = visualTokens({ byteLength: base64Bytes(image.data), ...image })
  return tokens === null ? null : `~${formatTokens(tokens)} tokens`
}

/**
 * What a picture that rode along with the message reads as afterwards. The cost is the reason the
 * row exists: an image is spent tokens that the text beside it never accounts for, and the
 * transcript is the only place left to see what it took. The carrier adds its own mark — the
 * attachment chip prefixes `glyph.image` — so the text itself stays glyphless.
 */
export const saidImageText = (image: SaidImage): string =>
  [basename(image.path), sized(image), cost(image)]
    .filter((part): part is string => part !== null)
    .join(' · ')
