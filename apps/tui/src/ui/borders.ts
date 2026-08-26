import type { BorderCharacters } from '@opentui/core'

/**
 * Every box-drawing slot blanked, so a `border` side draws only the one character put back. A
 * left-only border draws no corners, so a rail is capped by stacking rows rather than by setting
 * `topLeft` / `bottomLeft`.
 */
export const BLANK_BORDER: BorderCharacters = {
  topLeft: '',
  topRight: '',
  bottomLeft: '',
  bottomRight: '',
  horizontal: ' ',
  vertical: '',
  topT: '',
  bottomT: '',
  leftT: '',
  rightT: '',
  cross: '',
}

export const RAIL = '┃'

export const RAIL_HEAD = '╻'

export const RAIL_TAIL = '╹'

export const PANEL_TOP_EDGE = '▄'

export const PANEL_BOTTOM_EDGE = '▀'
