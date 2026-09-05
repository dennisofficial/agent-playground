import React from 'react'

import { refKey, supportedEfforts, type ModelRef } from '@dltech/atlas-core'

import { EFFORT_ABBREVIATION } from '../effort-label'
import { fitHints, hintSpans, hintWidth, type Hint } from '../hint-layout'
import { useHover } from '../hooks/use-hover'
import { type PressHandlers, usePress } from '../hooks/use-press'
import {
  ESwitcherRow,
  selectedCard,
  shownCount,
  type SwitcherChoice,
  type SwitcherRow,
  type SwitcherState,
} from '../switcher-model'
import { theme } from '../theme'
import { drawerCells, DrawerHeading, DrawerLine, DRAWER_INSET, SideDrawer } from './drawer'
import { clipSpans } from './sidebar/cells'
import { Spans } from './spans'
import { useSelectionInView } from './switcher/follow'
import {
  AppliesLine,
  EffortLine,
  FilterLine,
  ModelLine,
  NothingMatchedLine,
  ProviderLine,
} from './switcher/lines'

export const SWITCHER_INSET = DRAWER_INSET

export const switcherCells = (args: { width: number }): number => drawerCells(args)

export { EFFORT_ABBREVIATION }

const WALKING_AWAY: readonly Hint[] = [
  { key: '↑↓', label: 'pick' },
  { key: '⏎', label: 'switch' },
]

const PINNING: Hint = { key: '*', label: 'pin' }

const FILTERING: Hint = { key: 'type', label: 'filter' }

function footerHints(args: { cells: number; currentLabel: string }): readonly Hint[] {
  const keep = { key: 'esc', label: `keep ${args.currentLabel}` }

  const offered = [...WALKING_AWAY, PINNING, FILTERING, keep]
  if (hintWidth(offered) <= args.cells) return offered

  const shorter = [...WALKING_AWAY, PINNING, keep]
  if (hintWidth(shorter) <= args.cells) return shorter

  const named = [...WALKING_AWAY, PINNING, { key: 'esc', label: 'keep' }]
  if (hintWidth(named) <= args.cells) return named

  const bare = [...WALKING_AWAY, { key: 'esc', label: 'keep' }]
  return fitHints({ hints: bare, cells: args.cells })
}

function FooterLine(props: {
  cells: number
  currentLabel: string
  press: PressHandlers
}): React.ReactNode {
  const spans = hintSpans({
    hints: footerHints({ cells: props.cells, currentLabel: props.currentLabel }),
    keyColour: theme.meta,
  })

  return (
    <DrawerLine press={props.press}>
      <text>
        <Spans spans={clipSpans({ spans, cells: props.cells })} />
      </text>
    </DrawerLine>
  )
}

const activeLabel = (args: { rows: readonly SwitcherRow[]; active: ModelRef }): string => {
  const wanted = refKey(args.active)
  const found = args.rows.find(
    (row) => row.kind === ESwitcherRow.Model && refKey(row.card.ref) === wanted,
  )
  return found?.kind === ESwitcherRow.Model ? found.card.label : args.active.modelId
}

export function Switcher(props: {
  width: number
  rows: readonly SwitcherRow[]
  state: SwitcherState
  active: ModelRef
  total: number
  query?: string
  toDefault?: boolean
  overlay?: boolean
  onPick: (choice: SwitcherChoice) => void
  onSelect: (index: number) => void
  onDismiss: () => void
  onQueryChange?: ((value: string) => void) | undefined
}): React.ReactNode {
  const cells = switcherCells({ width: props.width })
  const press = usePress()
  const { hovered, handlersFor } = useHover()
  const activeKey = refKey(props.active)
  const rungs = supportedEfforts(selectedCard({ state: props.state, rows: props.rows })?.effort)
  const attach = useSelectionInView({ rows: props.rows, index: props.state.index })

  return (
    <SideDrawer
      width={props.width}
      overlay={props.overlay === true}
      lifted={props.toDefault === true}
      footer={
        <FooterLine
          cells={cells}
          currentLabel={activeLabel({ rows: props.rows, active: props.active })}
          press={press(props.onDismiss)}
        />
      }
    >
      <box flexDirection="column" flexGrow={1} flexShrink={1} flexBasis={0}>
        <DrawerHeading label={props.toDefault === true ? 'Default model' : 'Model'} />
        <FilterLine
          cells={cells}
          query={props.query ?? ''}
          shown={shownCount(props.rows)}
          total={props.total}
          onQueryChange={props.onQueryChange}
        />
        {props.rows.length === 0 ? <NothingMatchedLine cells={cells} /> : null}
        <scrollbox ref={attach} flexGrow={1} flexShrink={1} flexBasis={0} focusable={false}>
          {props.rows.map((row, index) => {
            if (row.kind === ESwitcherRow.Header)
              return (
                <ProviderLine key={`header:${row.providerId}`} label={row.label} cells={cells} />
              )

            const key = refKey(row.card.ref)
            const take = row.available ? () => props.onSelect(index) : undefined

            return (
              <ModelLine
                key={key}
                id={key}
                card={row.card}
                cells={cells}
                active={key === activeKey}
                selected={index === props.state.index}
                hovered={row.available && hovered === key}
                available={row.available}
                press={press(take)}
                hover={handlersFor(row.available ? key : undefined)}
              />
            )
          })}
        </scrollbox>
      </box>
      {rungs.length === 0 ? null : (
        <box flexDirection="column" flexShrink={0}>
          <DrawerHeading label="Effort" />
          <EffortLine cells={cells} effort={props.state.effort} rungs={rungs} />
        </box>
      )}
      <box flexDirection="column" flexShrink={0}>
        <DrawerHeading label="Applies" />
        <AppliesLine cells={cells} toDefault={props.toDefault === true} />
      </box>
    </SideDrawer>
  )
}
