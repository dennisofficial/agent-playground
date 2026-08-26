import React from 'react'

import { type EEffort, EFFORT_ORDER, EModelVendor, type ModelEntry } from '@dltech/atlas-core'

import { cellsOf, fitHints, hintSpans, hintWidth, type Hint } from '../hint-layout'
import { type PressHandlers, usePress } from '../hooks/use-press'
import {
  isModelAvailable,
  priceLabel,
  type SwitcherAvailability,
  type SwitcherChoice,
  type SwitcherState,
} from '../switcher-model'
import { glyph, theme } from '../theme'
import { clipSpans, spanCells } from './sidebar/cells'
import { Row } from './sidebar/row'
import { Spans, type Span } from './spans'

const PAD = 2

const EDGE = 1

export const SWITCHER_INSET = EDGE + PAD * 2

export const switcherCells = (args: { width: number }): number =>
  Math.max(0, args.width - SWITCHER_INSET)

const EFFORT_GAP = '  '

export const EFFORT_ABBREVIATION: Readonly<Record<EEffort, string>> = {
  low: 'low',
  medium: 'med',
  high: 'high',
}

const EFFORT_AFFORDANCE = '← →'

const GAP_CELLS = 1

function Line(props: {
  band?: string
  press?: PressHandlers
  children: React.ReactNode
}): React.ReactNode {
  return (
    <box
      height={1}
      flexShrink={0}
      paddingLeft={PAD}
      paddingRight={PAD}
      {...(props.band === undefined ? {} : { backgroundColor: props.band })}
      {...(props.press ?? {})}
    >
      {props.children}
    </box>
  )
}

function GroupHeader(props: { label: string }): React.ReactNode {
  return (
    <Line>
      <text fg={theme.meta}>{props.label.toUpperCase()}</text>
    </Line>
  )
}

function readOut(args: { entry: ModelEntry; available: boolean }): Span[] {
  if (!args.available) return [{ text: `${glyph.warning} no key`, fg: theme.warn }]
  if (args.entry.vendor !== EModelVendor.Anthropic)
    return [{ text: `via ${args.entry.vendor}`, fg: theme.hint }]
  return [{ text: priceLabel(args.entry), fg: theme.hint }]
}

function labelColour(args: { available: boolean; selected: boolean }): string {
  if (!args.available) return theme.meta
  return args.selected ? theme.bright : theme.hover
}

function ModelLine(props: {
  entry: ModelEntry
  cells: number
  active: boolean
  selected: boolean
  available: boolean
  press: PressHandlers
}): React.ReactNode {
  return (
    <Line {...(props.selected ? { band: theme.hoverBg } : {})} press={props.press}>
      <Row
        label={props.entry.label}
        labelFg={labelColour({ available: props.available, selected: props.selected })}
        cells={props.cells}
        mark={{
          text: props.active ? glyph.active : glyph.available,
          fg: props.active ? theme.accent : theme.hint,
        }}
        value={readOut({ entry: props.entry, available: props.available })}
      />
    </Line>
  )
}

function EffortLine(props: { cells: number; effort: EEffort }): React.ReactNode {
  const levels: Span[] = EFFORT_ORDER.flatMap((level, index) => [
    ...(index === 0 ? [] : [{ text: EFFORT_GAP }]),
    ...(level === props.effort
      ? [{ text: `${glyph.marker}${EFFORT_ABBREVIATION[level]}`, fg: theme.court.external }]
      : [{ text: EFFORT_ABBREVIATION[level], fg: theme.hint }]),
  ])
  const gap = Math.max(
    GAP_CELLS,
    props.cells - spanCells(levels) - cellsOf(EFFORT_AFFORDANCE),
  )

  return (
    <Line>
      <text>
        <Spans
          spans={clipSpans({
            spans: [
              ...levels,
              { text: ' '.repeat(gap) },
              { text: EFFORT_AFFORDANCE, fg: theme.hint },
            ],
            cells: props.cells,
          })}
        />
      </text>
    </Line>
  )
}

const APPLIES: readonly Span[] = [
  { text: `${glyph.swap} `, fg: theme.accent },
  { text: 'next turn', fg: theme.hover },
  { text: ' · keeps this transcript', fg: theme.hint },
]

function AppliesLine(props: { cells: number }): React.ReactNode {
  return (
    <Line>
      <text>
        <Spans spans={clipSpans({ spans: APPLIES, cells: props.cells })} />
      </text>
    </Line>
  )
}

const WALKING_AWAY: readonly Hint[] = [
  { key: '↑↓', label: 'pick' },
  { key: '⏎', label: 'switch' },
]

function footerHints(args: { cells: number; currentLabel: string }): readonly Hint[] {
  const named = [...WALKING_AWAY, { key: 'esc', label: `keep ${args.currentLabel}` }]
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
    <Line press={props.press}>
      <text>
        <Spans spans={clipSpans({ spans, cells: props.cells })} />
      </text>
    </Line>
  )
}

export function Switcher(props: {
  width: number
  models: readonly ModelEntry[]
  state: SwitcherState
  activeModelId: string
  availability?: SwitcherAvailability | undefined
  overlay?: boolean
  onPick: (choice: SwitcherChoice) => void
  onDismiss: () => void
}): React.ReactNode {
  const cells = switcherCells({ width: props.width })
  const press = usePress()
  const active = props.models.find((entry) => entry.id === props.activeModelId)

  return (
    <box
      flexDirection="column"
      flexShrink={0}
      width={props.width}
      backgroundColor={theme.overlayBg}
      border={['left']}
      borderColor={theme.rule}
      paddingTop={1}
      paddingBottom={1}
      {...(props.overlay
        ? { position: 'absolute' as const, top: 0, bottom: 0, right: 0, zIndex: 20 }
        : {})}
    >
      <box flexDirection="column" flexGrow={1} flexShrink={1} gap={1}>
        <box flexDirection="column" flexShrink={0}>
          <GroupHeader label="Model" />
          {props.models.map((entry, index) => {
            const available = isModelAvailable({
              modelId: entry.id,
              availability: props.availability,
            })
            const pick = available
              ? () => props.onPick({ modelId: entry.id, effort: props.state.effort })
              : undefined

            return (
              <ModelLine
                key={entry.id}
                entry={entry}
                cells={cells}
                active={entry.id === props.activeModelId}
                selected={index === props.state.index}
                available={available}
                press={press(pick)}
              />
            )
          })}
        </box>
        <box flexDirection="column" flexShrink={0}>
          <GroupHeader label="Effort" />
          <EffortLine cells={cells} effort={props.state.effort} />
        </box>
        <box flexDirection="column" flexShrink={0}>
          <GroupHeader label="Applies" />
          <AppliesLine cells={cells} />
        </box>
      </box>
      <FooterLine
        cells={cells}
        currentLabel={active?.label ?? props.activeModelId}
        press={press(props.onDismiss)}
      />
    </box>
  )
}
