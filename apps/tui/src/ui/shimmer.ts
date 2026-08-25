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

export function shimmerCycleMs(args: { cells: number; spec: ShimmerSpec }): number {
  return args.cells * args.spec.speedMs + args.spec.quietMs
}

export function shimmerCrest(args: {
  nowMs: number
  cells: number
  spec: ShimmerSpec
}): number {
  const cycle = shimmerCycleMs({ cells: args.cells, spec: args.spec })
  const phase = ((args.nowMs % cycle) + cycle) % cycle
  return phase / args.spec.speedMs
}

export function shimmerHeat(args: { index: number; crest: number; spec: ShimmerSpec }): number {
  return Math.max(0, 1 - Math.abs(args.index - args.crest) / args.spec.crestWidth)
}

export function beaconHeat(args: { crest: number; spec: ShimmerSpec }): number {
  return Math.max(0, 1 - args.crest / (args.spec.crestWidth * 2))
}
