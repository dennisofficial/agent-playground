import { useMemo } from 'react'

import type { ContributedSurface, PluginSurface } from '../plugins/surface'
import { plural } from '../store/tools/reading'
import { chipItem, EFooterItemReach, type FooterItem } from '../ui/footer-item'
import { theme } from '../ui/theme'
import type { AgentsControl } from './use-agents'
import type { AgentsPickerControl } from './use-agents-picker'

export function subagentsItem(args: { running: number; onOpen: () => void }): FooterItem | null {
  if (args.running === 0) return null

  return chipItem({
    id: 'subagents',
    text: plural(args.running, 'agent'),
    ground: theme.court.external,
    ink: theme.appBg,
    reach: EFooterItemReach.Keyboard,
    onActivate: args.onOpen,
  })
}

export const subagentsSurface = (args: {
  agents: AgentsControl
  picker: AgentsPickerControl
}): ContributedSurface => {
  const { running } = args.agents
  const { handleOpen } = args.picker

  return {
    pluginId: 'subagents',
    use: (): PluginSurface => {
      const footerItem = useMemo(
        () => subagentsItem({ running, onOpen: handleOpen }),
        [handleOpen, running],
      )

      return useMemo(() => ({ footerItem }), [footerItem])
    },
  }
}
