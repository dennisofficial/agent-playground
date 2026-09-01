import { projectedTokens, type EImageTier, type ImageSize } from './projection'

export type ImageRegion = { x: number; y: number; width: number; height: number }

export type RegionPlan =
  { ok: true; region: ImageRegion; clamped: boolean } | { ok: false; reason: string }

const outside = ({ region, size }: { region: ImageRegion; size: ImageSize }): string | null => {
  if (region.x >= size.width) {
    return `x ${region.x} starts past the right edge of a ${size.width}×${size.height} image`
  }
  if (region.y >= size.height) {
    return `y ${region.y} starts past the bottom edge of a ${size.width}×${size.height} image`
  }
  return null
}

/**
 * What a region asked for becomes once the picture's real size is known. A region that runs off the
 * edge is trimmed rather than refused, because the caller is reading coordinates off a description
 * of the image and being a few pixels generous should not cost it the read.
 */
export function planRegion({ size, region }: { size: ImageSize; region: ImageRegion }): RegionPlan {
  const reason = outside({ region, size })
  if (reason !== null) return { ok: false, reason }

  const width = Math.min(region.width, size.width - region.x)
  const height = Math.min(region.height, size.height - region.y)

  return {
    ok: true,
    region: { x: region.x, y: region.y, width, height },
    clamped: width !== region.width || height !== region.height,
  }
}

/**
 * What the crop is worth saying out loud: a pane lifted from a screenshot is cheaper than the frame
 * it came from, and the model should be told when it is not, so it can stop cropping and look wider.
 */
export function regionSaving({
  size,
  region,
  tier,
}: {
  size: ImageSize
  region: ImageSize
  tier?: EImageTier | undefined
}): { whole: number; cropped: number; saved: number } {
  const whole = projectedTokens({ size, tier })
  const cropped = projectedTokens({ size: region, tier })

  return { whole, cropped, saved: whole - cropped }
}
