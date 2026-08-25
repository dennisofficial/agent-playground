export type ShimmerSpec = {
  speedMs: number
  crestWidth: number
  quietMs: number
}

export const WORKING_SHIMMER: ShimmerSpec = {
  speedMs: 18,
  crestWidth: 6,
  quietMs: 1500,
}

export function shimmerCycleMs(cells: number, spec: ShimmerSpec): number {
  return cells * spec.speedMs + spec.quietMs
}

export function shimmerCrest(nowMs: number, cells: number, spec: ShimmerSpec): number {
  const cycle = shimmerCycleMs(cells, spec)
  const phase = ((nowMs % cycle) + cycle) % cycle
  return phase / spec.speedMs
}

export function shimmerHeat(index: number, crest: number, spec: ShimmerSpec): number {
  return Math.max(0, 1 - Math.abs(index - crest) / spec.crestWidth)
}

export function beaconHeat(crest: number, spec: ShimmerSpec): number {
  return Math.max(0, 1 - crest / (spec.crestWidth * 2))
}
