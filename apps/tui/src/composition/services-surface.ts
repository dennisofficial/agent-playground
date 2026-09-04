import { useMemo } from 'react'

import type { ContributedSurface, PluginSurface } from '../plugins/surface'
import { plural } from '../store/tools/reading'
import { chipItem, EFooterItemReach, type FooterItem } from '../ui/footer-item'
import { SERVICE_BLUE, theme } from '../ui/theme'
import type { ServicesControl } from './use-services'

export function servicesItem(args: { running: number; onOpen: () => void }): FooterItem | null {
  if (args.running === 0) return null

  return chipItem({
    id: 'services',
    text: plural(args.running, 'service'),
    ground: SERVICE_BLUE,
    ink: theme.appBg,
    reach: EFooterItemReach.Keyboard,
    onActivate: args.onOpen,
  })
}

export const servicesSurface = (args: { services: ServicesControl }): ContributedSurface => {
  const { running, handleOpen } = args.services

  return {
    pluginId: 'services',
    use: (): PluginSurface => {
      const footerItem = useMemo(
        () => servicesItem({ running, onOpen: handleOpen }),
        [handleOpen, running],
      )

      return useMemo(() => ({ footerItem }), [footerItem])
    },
  }
}
