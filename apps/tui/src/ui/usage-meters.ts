import {
  EMeterBand,
  EUsageWindow,
  formatCountdown,
  formatUtilization,
  meterBand,
  type AccountUsage,
  type UsageWindow,
} from '@dltech/atlas-core'

export enum EFooterMeters {
  All = 'all',
  Session = 'session',
  Context = 'context',
}

export const SHIPPED_FOOTER_METERS = EFooterMeters.All

export type FooterMeter = { label: string; band: EMeterBand; text: string }

const SHOWN: Record<EFooterMeters, readonly EUsageWindow[]> = {
  [EFooterMeters.All]: [EUsageWindow.FiveHour, EUsageWindow.SevenDay],
  [EFooterMeters.Session]: [EUsageWindow.FiveHour],
  [EFooterMeters.Context]: [],
}

const LABEL: Record<EUsageWindow, string> = {
  [EUsageWindow.FiveHour]: '5h',
  [EUsageWindow.SevenDay]: 'wk',
}

export function footerMetersOf(value: string): EFooterMeters {
  const known = Object.values(EFooterMeters).find((meters) => meters === value)
  return known ?? SHIPPED_FOOTER_METERS
}

function textOf(args: { window: UsageWindow | null; band: EMeterBand; now: number }): string {
  if (args.band !== EMeterBand.Spent) return formatUtilization(args.window?.utilization ?? null)

  const countdown = formatCountdown({ resetsAt: args.window?.resetsAt ?? null, now: args.now })
  return countdown === '' ? 'full' : countdown
}

export function usageMeters(args: {
  usage: AccountUsage
  show: EFooterMeters
  warn: Record<EUsageWindow, number>
  now: number
}): readonly FooterMeter[] {
  return SHOWN[args.show].map((key) => {
    const window = args.usage[key]
    const band = meterBand({ utilization: window?.utilization ?? null, warnAt: args.warn[key] })
    return { label: LABEL[key], band, text: textOf({ window, band, now: args.now }) }
  })
}
