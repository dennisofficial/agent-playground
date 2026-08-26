import React from 'react'

import { useClickRegion } from '../hooks/use-click-region'
import { theme, TRANSCRIPT_INSET } from '../theme'

export const UNSEEN_ANCHOR_ID = 'atlas-unseen-anchor'

const LABEL = ' new '

const STUB = 4

/**
 * `─── new ───`, above the oldest entry you have not seen. Drawn for the whole visit rather than
 * until you scroll past it: a boundary that moves while you read makes what it marked unfindable.
 */
export function NewDivider(props: { width: number }): React.ReactNode {
  const total = Math.max(LABEL.length + STUB * 2, props.width - TRANSCRIPT_INSET)
  const left = Math.max(STUB, Math.floor((total - LABEL.length) / 2))
  const right = Math.max(STUB, total - LABEL.length - left)

  return (
    <box flexDirection="row" marginTop={1} marginBottom={1}>
      <text fg={theme.court.yours}>
        {'─'.repeat(left)}
        {LABEL}
        {'─'.repeat(right)}
      </text>
    </box>
  )
}

const JUMP_LABEL = '⌄ jump to bottom'

const JUMP_WIDTH = JUMP_LABEL.length + 2

/**
 * Shown only while the transcript is scrolled away from the end. It floats over the bottom of the
 * transcript rather than taking a row above the composer, and is opaque because it is drawn over
 * live text.
 */
export function JumpToBottom(props: { width: number; onJump: () => void }): React.ReactNode {
  const left = Math.max(0, Math.floor((props.width - TRANSCRIPT_INSET - JUMP_WIDTH) / 2))
  const { hovered, handlers } = useClickRegion(props.onJump)
  const ground = hovered ? theme.hoverBg : theme.overlayBg

  return (
    <box
      position="absolute"
      bottom={0}
      left={left}
      zIndex={10}
      flexDirection="row"
      paddingLeft={1}
      paddingRight={1}
      backgroundColor={ground}
      {...handlers}
    >
      <text fg={hovered ? theme.bright : theme.hover} bg={ground}>
        {JUMP_LABEL}
      </text>
    </box>
  )
}
