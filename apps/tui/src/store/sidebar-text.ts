import { sidebarCells } from '../ui/components/sidebar/cells'
import { SIDEBAR_WIDTH } from '../ui/theme'

export const TITLE_CELLS = sidebarCells({ width: SIDEBAR_WIDTH })

export const oneLineOf = (text: string): string | null => {
  const oneLine = text.replace(/\s+/g, ' ').trim()
  return oneLine.length === 0 ? null : oneLine
}
