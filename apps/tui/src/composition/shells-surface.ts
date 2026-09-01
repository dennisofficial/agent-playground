import { useMemo } from 'react'

import type { ContributedSurface, PluginSurface } from '../plugins/surface'
import { EFooterItemReach, type FooterItem } from '../ui/footer-item'
import { glyph, theme } from '../ui/theme'
import type { ShellsControl } from './use-shells'

export function shellsItem(args: {
  running: number
  total: number
  onOpen: () => void
}): FooterItem | null {
  if (args.total === 0) return null

  return {
    id: 'shells',
    spans: [
      { text: glyph.active, fg: args.running > 0 ? theme.ok : theme.rule },
      { text: ` ${args.running}/${args.total}`, fg: theme.hint },
    ],
    reach: EFooterItemReach.Keyboard,
    onActivate: args.onOpen,
  }
}

export const shellsSurface = (args: { shells: ShellsControl }): ContributedSurface => {
  const { running, everywhere, handleOpen } = args.shells
  const total = everywhere.length

  return {
    pluginId: 'shells',
    use: (): PluginSurface => {
      const footerItem = useMemo(
        () => shellsItem({ running, total, onOpen: handleOpen }),
        [handleOpen, running, total],
      )

      return useMemo(() => ({ footerItem }), [footerItem])
    },
  }
}
