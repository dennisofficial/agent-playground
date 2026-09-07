import React, { type ReactNode } from 'react'

import {
  BLANK_BORDER,
  FRAME_BOTTOM_LEFT,
  FRAME_BOTTOM_RIGHT,
  FRAME_HORIZONTAL,
  FRAME_TOP_LEFT,
  FRAME_TOP_RIGHT,
  FRAME_VERTICAL,
} from '../borders'

export const FRAME_PAD = 2

export const FRAME_INSET = 1 + FRAME_PAD

export enum EFrameRule {
  Box = 'box',
  Open = 'open',
}

const TOP_CHARS = {
  ...BLANK_BORDER,
  topLeft: FRAME_TOP_LEFT,
  topRight: FRAME_TOP_RIGHT,
  horizontal: FRAME_HORIZONTAL,
}

const SIDE_CHARS = { ...BLANK_BORDER, vertical: FRAME_VERTICAL }

const BOTTOM_CHARS = {
  ...BLANK_BORDER,
  bottomLeft: FRAME_BOTTOM_LEFT,
  bottomRight: FRAME_BOTTOM_RIGHT,
  horizontal: FRAME_HORIZONTAL,
}

const OPEN_CHARS = { ...BLANK_BORDER, horizontal: FRAME_HORIZONTAL }

/**
 * The other reading of a bounded block: one ground, ruled rather than filled. `Panel` earns its
 * separation from the transcript with a darker fill and half-row caps, which costs a cell its whole
 * colour budget and leaves none for a border. A frame spends nothing on ground, so the line is the
 * only thing it draws.
 *
 * `EFrameRule.Open` keeps the two rules and drops the sides, which leaves the body free to start at
 * the margin behind a `lead` of its own.
 *
 * The rules are stacked as their own rows rather than set on one bordered box, because a bordered
 * box puts its content below the top rule and the slabs have to sit *on* it.
 */
export function Frame(props: {
  colour: string
  rule?: EFrameRule
  lead?: ReactNode
  width?: number
  label?: ReactNode
  badge?: ReactNode
  title?: ReactNode
  children: ReactNode
}): React.ReactNode {
  const open = props.rule === EFrameRule.Open

  return (
    <box
      flexDirection="column"
      flexShrink={0}
      {...(props.width === undefined ? {} : { width: props.width })}
    >
      <box
        height={1}
        flexShrink={0}
        border={open ? ['top'] : ['top', 'left', 'right']}
        borderColor={props.colour}
        customBorderChars={open ? OPEN_CHARS : TOP_CHARS}
      />
      <box
        flexShrink={0}
        flexDirection="row"
        alignItems="flex-start"
        paddingRight={FRAME_PAD}
        {...(open
          ? {}
          : {
              border: ['left' as const, 'right' as const],
              borderColor: props.colour,
              customBorderChars: SIDE_CHARS,
              paddingLeft: FRAME_PAD,
            })}
      >
        {props.lead}
        {props.children}
      </box>
      <box
        height={1}
        flexShrink={0}
        border={open ? ['bottom'] : ['bottom', 'left', 'right']}
        borderColor={props.colour}
        customBorderChars={open ? OPEN_CHARS : BOTTOM_CHARS}
      />
      {props.label === undefined ? null : (
        <box position="absolute" top={0} left={FRAME_PAD} zIndex={5}>
          {props.label}
        </box>
      )}
      {props.badge === undefined && props.title === undefined ? null : (
        <box position="absolute" top={0} right={FRAME_PAD} flexDirection="row" zIndex={5}>
          {props.badge}
          {props.badge === undefined || props.title === undefined ? null : <box width={1} />}
          {props.title}
        </box>
      )}
    </box>
  )
}
