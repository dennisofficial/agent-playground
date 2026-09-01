import type { ClassifierFold } from '../store/classifier-fold'
import { EFooterItemReach, type FooterItem } from './footer-item'
import { glyph, theme } from './theme'

export const NUDGE_MARKER_ID = 'nudge-degraded'

export const NUDGE_MARKER_TEXT = `${glyph.warning} nudge offline`

const MARKER: FooterItem = {
  id: NUDGE_MARKER_ID,
  spans: [{ text: NUDGE_MARKER_TEXT, fg: theme.warn }],
  reach: EFooterItemReach.None,
}

export function withNudgeMarker(args: {
  items: readonly FooterItem[]
  fold: ClassifierFold | null | undefined
}): readonly FooterItem[] {
  if (args.fold?.judgeUnreachable !== true) return args.items

  return [...args.items, MARKER]
}
