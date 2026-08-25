import { useState } from 'react'

import { theme } from '../theme'
import { usePress, type PressHandlers } from './use-press'

export type ClickRegion = {
  hovered: boolean
  handlers: PressHandlers & {
    onMouseOver?: () => void
    onMouseOut?: () => void
  }
  wash: { bg?: string }
}

export function useClickRegion(onToggle?: () => void): ClickRegion {
  const [hovered, setHovered] = useState(false)
  const press = usePress()
  if (onToggle === undefined) return { hovered: false, handlers: {}, wash: {} }
  return {
    hovered,
    handlers: {
      ...press(onToggle),
      onMouseOver: () => setHovered(true),
      onMouseOut: () => setHovered(false),
    },
    wash: hovered ? { bg: theme.hoverBg } : {},
  }
}
