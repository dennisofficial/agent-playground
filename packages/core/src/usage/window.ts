export enum EUsageWindow {
  FiveHour = 'fiveHour',
  SevenDay = 'sevenDay',
}

export type UsageWindow = { utilization: number; resetsAt: string | null }

export type AccountUsage = Record<EUsageWindow, UsageWindow | null>

export const NO_USAGE: AccountUsage = {
  [EUsageWindow.FiveHour]: null,
  [EUsageWindow.SevenDay]: null,
}

export function worstWindow(windows: readonly (UsageWindow | null)[]): UsageWindow | null {
  return windows.reduce<UsageWindow | null>(
    (worst, window) =>
      window !== null && (worst === null || window.utilization > worst.utilization) ? window : worst,
    null,
  )
}
