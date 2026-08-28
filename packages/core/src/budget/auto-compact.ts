import { contextPressure } from '../models/pressure'

export const AUTO_COMPACT_OFF = 0

export enum EAutoCompact {
  Hold = 'hold',
  AtTurnEnd = 'at-turn-end',
  BeforeOverflow = 'before-overflow',
}

/**
 * Whether a settled turn has left the window full enough to summarise without being asked. Zero
 * turns the automatic trigger off, which is the operator saying they will run /compact themselves.
 */
export function autoCompactAfterTurn({
  used,
  window,
  atPercent,
}: {
  used: number
  window: number
  atPercent: number
}): EAutoCompact {
  if (atPercent <= AUTO_COMPACT_OFF) return EAutoCompact.Hold
  if (window <= 0) return EAutoCompact.Hold

  const { percent } = contextPressure({ used, window })
  return percent >= atPercent ? EAutoCompact.AtTurnEnd : EAutoCompact.Hold
}

/**
 * Whether the next step would be sent a prompt the window cannot hold. Turning the threshold off
 * turns this off too: the operator asked to decide when history is summarised, and overruling them at
 * the hard limit would be the one moment that decision mattered. The turn stops instead, and says so.
 */
export function autoCompactBeforeStep({
  tokens,
  window,
  atPercent,
}: {
  tokens: number
  window: number
  atPercent: number
}): EAutoCompact {
  if (atPercent <= AUTO_COMPACT_OFF) return EAutoCompact.Hold
  if (window <= 0) return EAutoCompact.Hold
  return tokens >= window ? EAutoCompact.BeforeOverflow : EAutoCompact.Hold
}

export const overflowsWindow = ({ tokens, window }: { tokens: number; window: number }): boolean =>
  window > 0 && tokens >= window
