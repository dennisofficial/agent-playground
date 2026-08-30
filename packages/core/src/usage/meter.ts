import { EUsageWindow } from './window'

export enum EMeterBand {
  Unknown = 'unknown',
  Normal = 'normal',
  Warn = 'warn',
  Hot = 'hot',
  Red = 'red',
  Spent = 'spent',
}

export type MeterThresholds = { warn: number; hot: number; red: number }

export const DEFAULT_WARN_PERCENT: Record<EUsageWindow, number> = {
  [EUsageWindow.FiveHour]: 65,
  [EUsageWindow.SevenDay]: 70,
}

const HOT_OF_HEADROOM = 0.5
const RED_OF_HEADROOM = 0.8

export function meterThresholds(warn: number): MeterThresholds {
  const headroom = 100 - warn
  return {
    warn,
    hot: warn + Math.floor(headroom * HOT_OF_HEADROOM),
    red: warn + Math.floor(headroom * RED_OF_HEADROOM),
  }
}

export function meterBand(args: { utilization: number | null; warnAt: number }): EMeterBand {
  if (args.utilization === null) return EMeterBand.Unknown
  if (args.utilization >= 100) return EMeterBand.Spent

  const { warn, hot, red } = meterThresholds(args.warnAt)
  if (args.utilization >= red) return EMeterBand.Red
  if (args.utilization >= hot) return EMeterBand.Hot
  if (args.utilization >= warn) return EMeterBand.Warn
  return EMeterBand.Normal
}

export function isPressured(band: EMeterBand): boolean {
  return band !== EMeterBand.Normal && band !== EMeterBand.Unknown
}

export function meterFill(args: { utilization: number | null; cells: number }): number {
  if (args.utilization === null || args.utilization <= 0) return 0
  return Math.min(args.cells, Math.ceil((args.utilization / 100) * args.cells))
}
