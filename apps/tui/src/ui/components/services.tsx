import React from 'react'

import type { ServiceSnapshot } from '@dltech/atlas-harness'

import { type Hint } from '../hint-layout'
import type { OutputScroll } from '../hooks/use-output-scroll'
import { usePress, type PressHandlers } from '../hooks/use-press'
import { isServiceRunning, serviceNameLabel, serviceReadout } from '../services-model'
import { outputRows } from '../shells-model'
import { glyph, theme } from '../theme'
import {
  drawerCells,
  DrawerHints,
  DrawerLine,
  DRAWER_INSET,
  EDrawerEdge,
  SideDrawer,
} from './drawer'
import { clipSpans } from './sidebar/cells'
import { Spans, type Span } from './spans'

export const SERVICES_INSET = DRAWER_INSET

export const servicesCells = (args: { width: number }): number => drawerCells(args)

const SCROLLBACK_ROWS = 1_000

const SCROLLBAR_COLUMN = 1

const NOTHING_PRINTED = 'It has printed nothing yet.'

const BACK_TO_END = 'back to the end'

function GroupHeader(props: { label: string; count?: string; note?: string }): React.ReactNode {
  return (
    <DrawerLine>
      <text>
        <Spans
          spans={[
            { text: props.label.toUpperCase(), fg: theme.meta },
            ...(props.count === undefined ? [] : [{ text: `  ${props.count}`, fg: theme.hint }]),
            ...(props.note === undefined ? [] : [{ text: `  ${props.note}`, fg: theme.warn }]),
          ]}
        />
      </text>
    </DrawerLine>
  )
}

function markOf(service: ServiceSnapshot): Span {
  if (isServiceRunning(service)) return { text: glyph.active, fg: theme.ok }
  return { text: glyph.seen, fg: theme.rule }
}

function ServiceHeading(props: {
  service: ServiceSnapshot
  now: number
  cells: number
}): React.ReactNode {
  const { service } = props
  const state = serviceReadout({ service, now: props.now })

  const spans: Span[] = [
    markOf(service),
    { text: ' ' },
    { text: service.serviceId, fg: theme.bright },
    { text: '  ' },
    { text: serviceNameLabel(service), fg: theme.hover },
    { text: '  ' },
    { text: state, fg: theme.meta },
    { text: '  ' },
    { text: service.command.replace(/\s+/g, ' ').trim(), fg: theme.dim },
  ]

  return (
    <DrawerLine band={theme.panelBg}>
      <text>
        <Spans spans={clipSpans({ spans, cells: props.cells })} />
      </text>
    </DrawerLine>
  )
}

const STOP_AFFORDANCE = 'stop it'

function OutputSection(props: {
  service: ServiceSnapshot
  log: string
  cells: number
  press: PressHandlers
  jumpPress: PressHandlers
  scroll?: OutputScroll | undefined
}): React.ReactNode {
  const wrapCells = Math.max(0, props.cells - SCROLLBAR_COLUMN)
  const rows = outputRows({ text: props.log, cells: wrapCells, limit: SCROLLBACK_ROWS })
  const scroll = props.scroll
  const scrolledBack = scroll !== undefined && !scroll.pinned

  return (
    <box flexDirection="column" flexGrow={1} flexShrink={1} flexBasis={0}>
      <GroupHeader label="Log" {...(scrolledBack ? { note: 'scrolled back' } : {})} />
      {isServiceRunning(props.service) ? (
        <DrawerLine press={props.press}>
          <text>
            <Spans
              spans={[
                { text: `${glyph.failed} `, fg: theme.warn },
                { text: STOP_AFFORDANCE, fg: theme.hover },
              ]}
            />
          </text>
        </DrawerLine>
      ) : null}
      {rows.length === 0 ? (
        <DrawerLine>
          <text fg={theme.meta}>{NOTHING_PRINTED}</text>
        </DrawerLine>
      ) : (
        <scrollbox
          {...(scroll === undefined ? {} : { ref: scroll.attach })}
          flexGrow={1}
          flexShrink={1}
          flexBasis={0}
          focusable={false}
          stickyScroll
          stickyStart="bottom"
          viewportCulling
        >
          {rows.map((row, index) => (
            <DrawerLine key={index}>
              <text fg={theme.hover}>{row}</text>
            </DrawerLine>
          ))}
        </scrollbox>
      )}
      {scrolledBack ? (
        <DrawerLine press={props.jumpPress}>
          <text fg={theme.warn}>{`↓ ${BACK_TO_END}`}</text>
        </DrawerLine>
      ) : null}
    </box>
  )
}

const WALKING: readonly Hint[] = [
  { key: '↑↓', label: 'pick' },
  { key: 'pgup/pgdn', label: 'scroll' },
  { key: 'k', label: 'stop' },
  { key: 'esc', label: 'close' },
]

export function Services(props: {
  width: number
  services: readonly ServiceSnapshot[]
  now: number
  selected: ServiceSnapshot | undefined
  log: string
  scroll?: OutputScroll | undefined
  overlay?: boolean
  onStop: (serviceId: string) => void
  onDismiss: () => void
}): React.ReactNode {
  const cells = servicesCells({ width: props.width })
  const press = usePress()
  const running = props.services.filter(isServiceRunning).length
  const selected = props.selected

  return (
    <SideDrawer
      width={props.width}
      side={EDrawerEdge.Left}
      overlay={props.overlay === true}
      footer={<DrawerHints hints={WALKING} cells={cells} onDismiss={props.onDismiss} />}
    >
      {selected === undefined ? (
        <box flexDirection="column" flexShrink={0}>
          <GroupHeader label="Services" count={`${running}/${props.services.length}`} />
          <DrawerLine>
            <text fg={theme.meta}>Nothing is running as a service.</text>
          </DrawerLine>
        </box>
      ) : (
        <box flexDirection="column" flexGrow={1} flexShrink={1} flexBasis={0}>
          <GroupHeader label="Service log" count={`${running}/${props.services.length}`} />
          <ServiceHeading service={selected} now={props.now} cells={cells} />
          <OutputSection
            service={selected}
            log={props.log}
            cells={cells}
            press={press(() => props.onStop(selected.serviceId))}
            jumpPress={press(props.scroll?.handleJumpToEnd)}
            {...(props.scroll === undefined ? {} : { scroll: props.scroll })}
          />
        </box>
      )}
    </SideDrawer>
  )
}
