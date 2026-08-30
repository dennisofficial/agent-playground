import React from 'react'

import { RAIL } from '../borders'
import { useClickRegion } from '../hooks/use-click-region'
import { theme, TRANSCRIPT_INSET } from '../theme'
import { firstLineOf } from '../transcript-peek'
import { truncateCells } from './sidebar/cells'

export const PEEK_ROWS = 1

const PEEK_GUTTER = 2

const BACK_UP = '↑'

/**
 * The last thing you said, held at the top edge while you read below it. It floats over the
 * transcript rather than taking a row from it, and clicking it puts that message back at the top
 * so the reply beneath can be read from the beginning.
 */
export function PeekLine(props: {
  text: string
  width: number
  onJumpTo: () => void
}): React.ReactNode {
  const { hovered, handlers } = useClickRegion(props.onJumpTo)
  const ground = hovered ? theme.hoverBg : theme.userBg
  const band = Math.max(0, props.width - TRANSCRIPT_INSET)
  const room = Math.max(0, band - PEEK_GUTTER - BACK_UP.length - 1)

  return (
    <box
      position="absolute"
      top={0}
      left={0}
      width={band}
      height={PEEK_ROWS}
      zIndex={10}
      flexDirection="row"
      backgroundColor={ground}
      {...handlers}
    >
      <text fg={theme.court.yours} bg={ground}>
        {RAIL}
      </text>
      <text fg={hovered ? theme.bright : theme.meta} bg={ground}>
        {` ${truncateCells({ text: firstLineOf(props.text), cells: room })} `}
      </text>
      <box flexGrow={1} />
      <text fg={hovered ? theme.bright : theme.hint} bg={ground}>
        {`${BACK_UP} `}
      </text>
    </box>
  )
}
