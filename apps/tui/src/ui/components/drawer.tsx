import React from 'react'

import { fitHints, hintSpans, type Hint } from '../hint-layout'
import { theme } from '../theme'
import { clipSpans } from './sidebar/cells'
import { Spans } from './spans'
import type { HoverHandlers } from '../hooks/use-hover'
import { usePress, type PressHandlers } from '../hooks/use-press'

export const DRAWER_PAD = 2

export const DRAWER_EDGE = 1

export const DRAWER_INSET = DRAWER_EDGE + DRAWER_PAD * 2

export const drawerCells = (args: { width: number }): number =>
  Math.max(0, args.width - DRAWER_INSET)

/** Above the full-screen overlays, for a drawer opened from one of them. */
export const DRAWER_LIFTED_Z = 40

export enum EDrawerEdge {
  Left = 'left',
  Right = 'right',
  Bottom = 'bottom',
}

type Anchor = {
  border: 'left' | 'right' | 'top'
  zIndex: number
  top: number | undefined
  bottom: number
  left: number | undefined
  right: number | undefined
}

/**
 * A drawer rules off the edge it slides from, so the border sits opposite the anchor. The bottom
 * pair stacks above the side pair because it covers the composer, which owns the terminal cursor.
 */
const ANCHOR: Record<EDrawerEdge, Anchor> = {
  [EDrawerEdge.Right]: {
    border: 'left',
    zIndex: 20,
    top: 0,
    bottom: 0,
    left: undefined,
    right: 0,
  },
  [EDrawerEdge.Left]: {
    border: 'right',
    zIndex: 20,
    top: 0,
    bottom: 0,
    left: 0,
    right: undefined,
  },
  [EDrawerEdge.Bottom]: {
    border: 'top',
    zIndex: 30,
    top: undefined,
    bottom: 0,
    left: 0,
    right: 0,
  },
}

/**
 * Every positioning prop is passed on every render, never spread conditionally: OpenTUI's
 * reconciler leaves a prop that stops being supplied at whatever it last was, so a drawer that
 * dropped `position` while closing would keep the coordinates it floated at.
 */
function Drawer(props: {
  edge: EDrawerEdge
  width?: number | undefined
  overlay: boolean
  lifted?: boolean | undefined
  children: React.ReactNode
}): React.ReactNode {
  const anchor = ANCHOR[props.edge]
  const floating = props.lifted === true ? DRAWER_LIFTED_Z : anchor.zIndex

  return (
    <box
      flexDirection="column"
      flexShrink={0}
      backgroundColor={theme.overlayBg}
      border={[anchor.border]}
      borderColor={theme.rule}
      paddingTop={1}
      paddingBottom={1}
      position={props.overlay ? 'absolute' : 'relative'}
      zIndex={props.overlay ? floating : 0}
      {...(props.width === undefined ? {} : { width: props.width })}
      {...(anchor.top === undefined ? {} : { top: anchor.top })}
      {...(anchor.left === undefined ? {} : { left: anchor.left })}
      {...(anchor.right === undefined ? {} : { right: anchor.right })}
      bottom={anchor.bottom}
    >
      {props.children}
    </box>
  )
}

/**
 * The full-height drawer against a vertical edge. Its body takes the slack so the footer stays on
 * the last row however short the content is.
 */
export function SideDrawer(props: {
  width: number
  side?: EDrawerEdge.Left | EDrawerEdge.Right
  overlay?: boolean
  lifted?: boolean
  footer?: React.ReactNode
  children: React.ReactNode
}): React.ReactNode {
  return (
    <Drawer
      edge={props.side ?? EDrawerEdge.Right}
      width={props.width}
      overlay={props.overlay === true}
      lifted={props.lifted === true}
    >
      <box flexDirection="column" flexGrow={1} flexShrink={1} gap={1}>
        {props.children}
      </box>
      {props.footer}
    </Drawer>
  )
}

/**
 * The full-width drawer that rises from the bottom over the composer. Its height is whatever the
 * body asks for, so a body that can grow has to bound itself.
 */
export function BottomDrawer(props: {
  overlay?: boolean
  footer?: React.ReactNode
  children: React.ReactNode
}): React.ReactNode {
  return (
    <Drawer edge={EDrawerEdge.Bottom} overlay={props.overlay === true}>
      {props.children}
      {props.footer}
    </Drawer>
  )
}

export function DrawerLine(props: {
  children: React.ReactNode
  id?: string
  press?: PressHandlers
  hover?: HoverHandlers
  band?: string
}): React.ReactNode {
  return (
    <box
      height={1}
      flexShrink={0}
      paddingLeft={DRAWER_PAD}
      paddingRight={DRAWER_PAD}
      {...(props.id === undefined ? {} : { id: props.id })}
      {...(props.band === undefined ? {} : { backgroundColor: props.band })}
      {...(props.press ?? {})}
      {...(props.hover ?? {})}
    >
      {props.children}
    </box>
  )
}

export const DrawerGap = (): React.ReactNode => <box height={1} flexShrink={0} />

export function DrawerHeading(props: { label: string }): React.ReactNode {
  return (
    <DrawerLine>
      <text fg={theme.meta}>{props.label.toUpperCase()}</text>
    </DrawerLine>
  )
}

export function DrawerHints(props: {
  hints: readonly Hint[]
  cells: number
  onDismiss: () => void
}): React.ReactNode {
  const press = usePress()

  return (
    <DrawerLine press={press(props.onDismiss)}>
      <text>
        <Spans
          spans={clipSpans({
            spans: hintSpans({
              hints: fitHints({ hints: props.hints, cells: props.cells }),
              keyColour: theme.meta,
            }),
            cells: props.cells,
          })}
        />
      </text>
    </DrawerLine>
  )
}
