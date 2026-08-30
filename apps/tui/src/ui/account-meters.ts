import {
  EUsageWindow,
  formatCountdown,
  formatUtilization,
  meterBand,
  meterFill,
  type AccountUsage,
} from '@dltech/atlas-core'

import type { Span } from './components/spans'
import { meterTone } from './meter-tone'
import { theme } from './theme'

export const ACCOUNT_METER_CELLS = 5

const FILLED = '▰'

const EMPTY = '▱'

const LABEL: Record<EUsageWindow, string> = {
  [EUsageWindow.FiveHour]: '5h',
  [EUsageWindow.SevenDay]: 'wk',
}

const GAP = '  '

export function accountMeterSpans(args: {
  usage: AccountUsage
  warn: Record<EUsageWindow, number>
  now: number
}): Span[] {
  return [EUsageWindow.FiveHour, EUsageWindow.SevenDay].flatMap((key, index) => {
    const window = args.usage[key]
    const utilization = window?.utilization ?? null
    const band = meterBand({ utilization, warnAt: args.warn[key] })
    const tone = meterTone(band)
    const fill = meterFill({ utilization, cells: ACCOUNT_METER_CELLS })
    const countdown = formatCountdown({ resetsAt: window?.resetsAt ?? null, now: args.now })

    return [
      ...(index === 0 ? [] : [{ text: GAP }]),
      { text: `${LABEL[key]} `, fg: theme.rule },
      { text: FILLED.repeat(fill), fg: tone },
      { text: EMPTY.repeat(ACCOUNT_METER_CELLS - fill), fg: theme.rule },
      { text: ' ' },
      { text: countdown === '' ? formatUtilization(utilization) : countdown, fg: tone },
    ]
  })
}
