export type ImageSize = { width: number; height: number }

export enum EImageTier {
  Standard = 'standard',
  HighResolution = 'high-resolution',
}

export type TierLimits = { maxEdge: number; maxVisualTokens: number }

/**
 * Anthropic constrains an image on two axes at once, and for ordinary screenshots the token budget
 * binds before the edge does. https://platform.claude.com/docs/en/build-with-claude/vision
 */
export const TIER_LIMITS: Readonly<Record<EImageTier, TierLimits>> = {
  [EImageTier.Standard]: { maxEdge: 1568, maxVisualTokens: 1568 },
  [EImageTier.HighResolution]: { maxEdge: 2576, maxVisualTokens: 4784 },
}

/**
 * Claude 4.7 and later read at the high-resolution tier; everything else reads at standard, so an
 * uncatalogued model is assumed standard. A model that reads high-resolution still accepts a
 * standard-sized image; one that reads standard rejects or rescales an oversized one.
 */
export const DEFAULT_IMAGE_TIER = EImageTier.Standard

/** An image costs one token per 28×28 patch, padded up to the next whole patch on each edge. */
const PATCH_EDGE = 28

export const patchTokens = (size: ImageSize): number =>
  Math.ceil(size.width / PATCH_EDGE) * Math.ceil(size.height / PATCH_EDGE)

const paddedEdge = (edge: number): number => Math.ceil(edge / PATCH_EDGE) * PATCH_EDGE

const withinTier = ({ size, limits }: { size: ImageSize; limits: TierLimits }): boolean =>
  paddedEdge(size.width) <= limits.maxEdge &&
  paddedEdge(size.height) <= limits.maxEdge &&
  patchTokens(size) <= limits.maxVisualTokens

/**
 * Half-to-even, matching the reference implementation's Python `round`. The API resolves exact .5
 * ties toward the even neighbour, so `Math.round` computes a different short edge for some images.
 */
function roundTiesToEven(value: number): number {
  const floor = Math.floor(value)
  if (value - floor !== 0.5) return Math.round(value)
  return floor % 2 === 0 ? floor : floor + 1
}

/**
 * The size the API resizes an image to before padding, ported from the reference implementation at
 * https://platform.claude.com/docs/en/build-with-claude/vision-coordinates — a binary search along
 * the long edge, because no closed form satisfies both the edge and the token limit at once. That
 * page's worked table gives 1269×952 for a 2000×1500 standard-tier image where this search gives
 * 1270×952; the two cost an identical 1564 tokens, and the code is the half that is executable.
 */
export function projectedSize({
  size,
  tier = DEFAULT_IMAGE_TIER,
}: {
  size: ImageSize
  tier?: EImageTier | undefined
}): ImageSize {
  const limits = TIER_LIMITS[tier]
  if (withinTier({ size, limits })) return size

  if (size.height > size.width) {
    const rotated = projectedSize({ size: { width: size.height, height: size.width }, tier })
    return { width: rotated.height, height: rotated.width }
  }

  const aspectRatio = size.width / size.height
  const shortEdgeFor = (longEdge: number): number =>
    Math.max(roundTiesToEven(longEdge / aspectRatio), 1)

  let fitting = 1
  let failing = size.width

  while (fitting + 1 < failing) {
    const candidate = Math.floor((fitting + failing) / 2)
    const trial = { width: candidate, height: shortEdgeFor(candidate) }
    if (withinTier({ size: trial, limits })) fitting = candidate
    else failing = candidate
  }

  return { width: fitting, height: shortEdgeFor(fitting) }
}

export const projectedTokens = (args: { size: ImageSize; tier?: EImageTier | undefined }): number =>
  patchTokens(projectedSize(args))
