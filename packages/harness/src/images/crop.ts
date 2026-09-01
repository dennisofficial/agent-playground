import type { ImageRegion, ImageSize, SupportedImageMediaType } from '@dltech/atlas-core'

import { cropRaster, decodePng, encodePng } from './png'

export type CroppedImage = {
  bytes: Uint8Array
  size: ImageSize
  mediaType: SupportedImageMediaType
}

export type CropFailure = { reason: string }

const CROPPABLE: SupportedImageMediaType = 'image/png'

/**
 * PNG only, and on purpose. `sips` would take every format but silently returns the picture
 * untouched when the region ends on the bottom edge and starts at x = 0, which hands the model a
 * whole screenshot it believes is one pane. Decoding the bytes is exact and has no such corner.
 */
export function croppedImage({
  bytes,
  mediaType,
  region,
}: {
  bytes: Uint8Array
  mediaType: SupportedImageMediaType
  region: ImageRegion
}): CroppedImage | CropFailure {
  if (mediaType !== CROPPABLE) {
    return { reason: `region only works on PNG, and this is ${mediaType}` }
  }

  const image = decodePng(bytes)
  if (image === null) {
    return { reason: 'its PNG encoding is one this build cannot take apart' }
  }

  const cropped = cropRaster({ image, region })

  return { bytes: encodePng(cropped), size: cropped.size, mediaType: CROPPABLE }
}

export const isCropped = (result: CroppedImage | CropFailure): result is CroppedImage =>
  'bytes' in result
