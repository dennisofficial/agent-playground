export enum EEffort {
  Off = 'off',
  Minimal = 'minimal',
  Low = 'low',
  Medium = 'medium',
  High = 'high',
  XHigh = 'xhigh',
  Max = 'max',
}

export const EFFORT_LADDER: readonly EEffort[] = [
  EEffort.Off,
  EEffort.Minimal,
  EEffort.Low,
  EEffort.Medium,
  EEffort.High,
  EEffort.XHigh,
  EEffort.Max,
]

/**
 * A rung's value is what goes on the wire for it: a string is the provider's own effort literal,
 * a number is a thinking-token budget. Anthropic accepts one or the other per model and rejects
 * the wrong one outright.
 */
export type EffortMap = Partial<Record<EEffort, string | number>>

export const supportedEfforts = (map: EffortMap | undefined): readonly EEffort[] =>
  map === undefined ? [] : EFFORT_LADDER.filter((effort) => map[effort] !== undefined)

export function clampEffort(args: {
  map: EffortMap | undefined
  effort: EEffort
}): EEffort | undefined {
  const offered = supportedEfforts(args.map)
  if (offered.includes(args.effort)) return args.effort

  const asked = EFFORT_LADDER.indexOf(args.effort)
  const above = offered.find((effort) => EFFORT_LADDER.indexOf(effort) > asked)
  if (above !== undefined) return above

  return offered[offered.length - 1]
}

export function nextEffort(args: {
  map: EffortMap | undefined
  effort: EEffort
  delta: number
}): EEffort | undefined {
  const offered = supportedEfforts(args.map)
  const held = clampEffort({ map: args.map, effort: args.effort })
  if (held === undefined) return undefined

  const from = offered.indexOf(held)
  const target = Math.min(offered.length - 1, Math.max(0, from + Math.trunc(args.delta)))
  return offered[target] ?? held
}
