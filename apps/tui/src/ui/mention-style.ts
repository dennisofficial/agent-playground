import { SyntaxStyle } from '@opentui/core'

import { onPaletteChange } from './palette-store'
import { theme } from './theme'

export const MENTION_SCOPE = 'mention.file'

let styleCache: SyntaxStyle | null = null

export function mentionSyntaxStyle(): SyntaxStyle {
  styleCache ??= SyntaxStyle.fromStyles({
    default: { fg: theme.userFg },
    [MENTION_SCOPE]: { fg: theme.link, underline: true },
  })
  return styleCache
}

export function mentionStyleId(): number | null {
  return mentionSyntaxStyle().getStyleId(MENTION_SCOPE)
}

onPaletteChange(() => {
  styleCache = null
})
