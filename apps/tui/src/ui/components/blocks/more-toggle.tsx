/**
 * The `… +81 more` row under a truncated detail, and the click that opens it.
 *
 * A count with nothing behind it is a dead end: the reader is told what was withheld and given no
 * way to ask for it. Lighting the row under the pointer is what says the count is a control.
 */

import React from 'react'

import { useClickRegion } from '../../hooks/use-click-region'
import { theme } from '../../theme'

export type Expander = { expanded: boolean; onToggle?: () => void }

export const NOT_EXPANDABLE: Expander = { expanded: false }

export const shownOf = <T,>(args: {
  body: readonly T[]
  cap: number
  expand: Expander
}): readonly T[] => (args.expand.expanded ? args.body : args.body.slice(0, args.cap))

const labelOf = (args: { hidden: number; expanded: boolean }): string =>
  args.expanded ? '… show less' : `… +${args.hidden} more`

export function MoreToggle(props: {
  hidden: number
  indent: string
  expand: Expander
  width?: number
}): React.ReactNode {
  const region = useClickRegion(props.expand.onToggle)
  if (props.hidden <= 0) return null

  return (
    <text
      wrapMode="none"
      flexShrink={0}
      {...(props.width === undefined ? {} : { width: props.width })}
      {...region.handlers}
    >
      <span fg={region.hovered ? theme.hover : theme.rule} {...region.wash}>
        {`${props.indent}${labelOf({ hidden: props.hidden, expanded: props.expand.expanded })}`}
      </span>
    </text>
  )
}
