import React, { type ReactNode } from 'react'

import {
  BLANK_BORDER,
  PANEL_BOTTOM_EDGE,
  PANEL_TOP_EDGE,
  RAIL,
  RAIL_HEAD,
  RAIL_TAIL,
} from '../borders'
import { blockDensity, EBlockDensity } from '../density-store'

export const PANEL_PAD = 2

export const PANEL_INSET = 1 + PANEL_PAD

const RAIL_CHARS = { ...BLANK_BORDER, vertical: RAIL }

const HEAD_CHARS = { ...BLANK_BORDER, vertical: RAIL_HEAD }

const TAIL_CHARS = { ...BLANK_BORDER, vertical: RAIL_TAIL }

const TOP_EDGE_CHARS = { ...BLANK_BORDER, horizontal: PANEL_TOP_EDGE }

const BOTTOM_EDGE_CHARS = { ...BLANK_BORDER, horizontal: PANEL_BOTTOM_EDGE }

const railed = (rail?: string) =>
  rail === undefined
    ? {}
    : { border: ['left' as const], borderColor: rail, customBorderChars: RAIL_CHARS }

/**
 * The head's right corner. Both slabs stop `PANEL_PAD` short of the edge, so the row closes on the
 * half glyph rather than on a filled cell; when they share the row the badge sits one `▄` left of
 * the title.
 */
function RightSlot(props: { badge?: ReactNode; title?: ReactNode }): ReactNode {
  if (props.badge === undefined && props.title === undefined) return null

  return (
    <box position="absolute" top={0} right={PANEL_PAD} flexDirection="row" zIndex={5}>
      {props.badge}
      {props.badge === undefined || props.title === undefined ? null : <box width={1} />}
      {props.title}
    </box>
  )
}

/**
 * Half a row of fill, drawn as the foreground of `▄` or `▀` over the terminal's own ground. The
 * rail is capped on the same row by `╻` / `╹`, which are heavy verticals of the matching half
 * height — so a filled panel opens and closes on a half cell at both ends.
 */
function Edge(props: {
  rail?: string
  fill: string
  label?: ReactNode
  badge?: ReactNode
  title?: ReactNode
  head: boolean
}): ReactNode {
  return (
    <box
      height={1}
      flexShrink={0}
      {...(props.rail === undefined
        ? {}
        : {
            border: ['left' as const],
            borderColor: props.rail,
            customBorderChars: props.head ? HEAD_CHARS : TAIL_CHARS,
          })}
    >
      <box
        height={1}
        flexGrow={1}
        border={[props.head ? 'top' : 'bottom']}
        borderColor={props.fill}
        customBorderChars={props.head ? TOP_EDGE_CHARS : BOTTOM_EDGE_CHARS}
      />
      {props.label === undefined ? null : (
        <box position="absolute" top={0} left={PANEL_PAD} zIndex={5}>
          {props.label}
        </box>
      )}
      <RightSlot
        {...(props.badge === undefined ? {} : { badge: props.badge })}
        {...(props.title === undefined ? {} : { title: props.title })}
      />
    </box>
  )
}

/**
 * Where two grounds meet inside one panel: `▀` in the upper colour over the lower one as its cell
 * background, so the band closes on the same half cell the panel opened on and the body starts
 * mid-row. The rail runs full height here — the panel is not ending, only changing ground.
 */
function Seam(props: { rail?: string; above: string; below: string }): ReactNode {
  return (
    <box height={1} flexShrink={0} {...railed(props.rail)}>
      <box
        height={1}
        flexGrow={1}
        backgroundColor={props.below}
        border={['bottom' as const]}
        borderColor={props.above}
        customBorderChars={BOTTOM_EDGE_CHARS}
      />
    </box>
  )
}

function Band(props: { rail?: string; fill: string; children: ReactNode }): ReactNode {
  return (
    <box height={1} flexShrink={0} {...railed(props.rail)}>
      <box
        height={1}
        flexGrow={1}
        flexDirection="row"
        backgroundColor={props.fill}
        paddingLeft={PANEL_PAD}
        paddingRight={PANEL_PAD}
      >
        {props.children}
      </box>
    </box>
  )
}

/**
 * The one shape the app is built from. `fill` decides which of the two readings it takes: filled
 * and capped for something bounded, a bare rail for prose that runs on.
 */
/**
 * The rail is the operator's mark — the draft and the messages they sent carry one, and nothing
 * else in the app does. `fill` is separate: it raises a slab out of the transcript, capped at both
 * ends by a half row.
 *
 * `label`, `badge` and `title` are set into the head band, so they need their own background to
 * stand clear of the `▄` behind them. A `header` instead spends a whole row on its own ground,
 * seamed off the body below it whenever `band` is a different colour from `fill`.
 */
export function Panel(props: {
  rail?: string
  fill?: string
  band?: string
  label?: ReactNode
  badge?: ReactNode
  title?: ReactNode
  header?: ReactNode
  width?: number
  children: ReactNode
}): React.ReactNode {
  const sized = props.width === undefined ? {} : { width: props.width }

  const body = (
    <box
      flexShrink={0}
      {...(props.rail === undefined ? {} : railed(props.rail))}
      {...(props.fill === undefined ? sized : {})}
    >
      <box
        flexDirection="column"
        flexGrow={1}
        flexShrink={0}
        paddingLeft={PANEL_PAD}
        {...(props.fill === undefined
          ? {}
          : { backgroundColor: props.fill, paddingRight: PANEL_PAD })}
      >
        {props.children}
      </box>
    </box>
  )

  if (props.fill === undefined) return body

  const band = props.band ?? props.fill
  const headed = props.header !== undefined
  const comfort = blockDensity() === EBlockDensity.Comfort
  const capped = !headed || comfort
  const seamed = headed && comfort && band !== props.fill

  return (
    <box flexDirection="column" flexShrink={0} {...sized}>
      {capped ? (
        <Edge
          head
          fill={band}
          {...(props.rail === undefined ? {} : { rail: props.rail })}
          {...(props.label === undefined ? {} : { label: props.label })}
          {...(props.badge === undefined ? {} : { badge: props.badge })}
          {...(props.title === undefined ? {} : { title: props.title })}
        />
      ) : null}
      {props.header === undefined ? null : (
        <Band fill={band} {...(props.rail === undefined ? {} : { rail: props.rail })}>
          {props.header}
        </Band>
      )}
      {seamed ? (
        <Seam
          above={band}
          below={props.fill}
          {...(props.rail === undefined ? {} : { rail: props.rail })}
        />
      ) : null}
      {body}
      {capped ? (
        <Edge
          head={false}
          fill={props.fill}
          {...(props.rail === undefined ? {} : { rail: props.rail })}
        />
      ) : null}
    </box>
  )
}
