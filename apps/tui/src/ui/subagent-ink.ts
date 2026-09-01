import { ESubagentReading } from '../store/subagent-row'
import { glyph, theme } from './theme'

export const MARK_OF: Record<ESubagentReading, { text: string; fg: string }> = {
  [ESubagentReading.Live]: { text: glyph.active, fg: theme.court.external },
  [ESubagentReading.Held]: { text: glyph.warning, fg: theme.warn },
  [ESubagentReading.Settled]: { text: glyph.seen, fg: theme.rule },
}

export const NAME_INK_OF: Record<ESubagentReading, string> = {
  [ESubagentReading.Live]: theme.hover,
  [ESubagentReading.Held]: theme.hover,
  [ESubagentReading.Settled]: theme.meta,
}

export const STATE_INK_OF: Record<ESubagentReading, string> = {
  [ESubagentReading.Live]: theme.hint,
  [ESubagentReading.Held]: theme.warn,
  [ESubagentReading.Settled]: theme.meta,
}
