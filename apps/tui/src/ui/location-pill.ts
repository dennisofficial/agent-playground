import { EExecutionLocation } from '@dltech/atlas-core'

import { chipItem, EFooterItemReach, type FooterItem } from './footer-item'
import { theme } from './theme'

export function locationPillOf(args: { location: EExecutionLocation }): FooterItem | null {
  if (args.location === EExecutionLocation.Host) return null

  return chipItem({
    id: 'execution-location',
    text: args.location,
    ground: theme.link,
    reach: EFooterItemReach.None,
  })
}
