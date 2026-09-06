import React from 'react'

import { ESettingId, type EEffort, type ModelCard } from '@dltech/atlas-core'

import { EFFORT_ABBREVIATION } from '../../effort-label'
import { cellsOf } from '../../hint-layout'
import { type HoverHandlers } from '../../hooks/use-hover'
import { type PressHandlers } from '../../hooks/use-press'
import { EModelScope, priceLabel, type SwitcherTarget } from '../../switcher-model'
import { glyph, theme } from '../../theme'
import { DrawerLine } from '../drawer'
import { clipSpans, spanCells } from '../sidebar/cells'
import { Row } from '../sidebar/row'
import { Spans, type Span } from '../spans'

const EFFORT_GAP = '  '

const EFFORT_AFFORDANCE = '← →'

const FILTER_PLACEHOLDER = 'type to filter'

const NOTHING_MATCHED = 'no model by that name'

const GAP_CELLS = 1

function readOut(args: { card: ModelCard; available: boolean }): Span[] {
  if (!args.available) return [{ text: `${glyph.warning} no key`, fg: theme.warn }]

  const price = priceLabel(args.card)
  return price === null ? [] : [{ text: price, fg: theme.hint }]
}

function labelColour(args: { available: boolean; lit: boolean }): string {
  if (!args.available) return theme.meta
  return args.lit ? theme.bright : theme.hover
}

function TextLine(props: { spans: readonly Span[]; cells: number }): React.ReactNode {
  return (
    <DrawerLine>
      <text>
        <Spans spans={clipSpans({ spans: props.spans, cells: props.cells })} />
      </text>
    </DrawerLine>
  )
}

export function ProviderLine(props: { label: string; cells: number }): React.ReactNode {
  return <TextLine spans={[{ text: props.label, fg: theme.meta }]} cells={props.cells} />
}

export function NothingMatchedLine(props: { cells: number }): React.ReactNode {
  return <TextLine spans={[{ text: NOTHING_MATCHED, fg: theme.hint }]} cells={props.cells} />
}

const tally = (args: { shown: number; total: number }): { text: string; fg: string } => ({
  text: args.shown === args.total ? `${args.total}` : `${args.shown} of ${args.total}`,
  fg: theme.hint,
})

export function FilterLine(props: {
  cells: number
  query: string
  shown: number
  total: number
  onQueryChange?: ((value: string) => void) | undefined
}): React.ReactNode {
  const counted = tally({ shown: props.shown, total: props.total })

  return (
    <DrawerLine>
      <box flexDirection="row" flexGrow={1}>
        <text fg={theme.accent}>{`${glyph.marker} `}</text>
        <input
          flexGrow={1}
          value={props.query}
          focused
          placeholder={FILTER_PLACEHOLDER}
          textColor={theme.bright}
          placeholderColor={theme.hint}
          cursorColor={theme.caretBg}
          {...(props.onQueryChange === undefined ? {} : { onInput: props.onQueryChange })}
        />
        <text fg={counted.fg}>{counted.text}</text>
      </box>
    </DrawerLine>
  )
}

/**
 * Two grounds, because a click no longer switches: the pointer's band says what a click would take
 * the highlight to, and the highlight's own band says what ⏎ would switch to.
 */
const bandOf = (args: { selected: boolean; hovered: boolean }): string | undefined => {
  if (args.selected) return theme.selectedBg
  return args.hovered ? theme.hoverBg : undefined
}

export function ModelLine(props: {
  card: ModelCard
  cells: number
  active: boolean
  selected: boolean
  hovered: boolean
  available: boolean
  id: string
  press: PressHandlers
  hover: HoverHandlers
}): React.ReactNode {
  const band = bandOf({ selected: props.selected, hovered: props.hovered })

  return (
    <DrawerLine
      id={props.id}
      {...(band === undefined ? {} : { band })}
      press={props.press}
      hover={props.hover}
    >
      <Row
        label={props.card.label}
        labelFg={labelColour({
          available: props.available,
          lit: props.selected || props.hovered,
        })}
        cells={props.cells}
        mark={{
          text: props.active ? glyph.active : glyph.available,
          fg: props.active ? theme.accent : theme.hint,
        }}
        value={readOut({ card: props.card, available: props.available })}
      />
    </DrawerLine>
  )
}

export function EffortLine(props: {
  cells: number
  effort: EEffort
  rungs: readonly EEffort[]
}): React.ReactNode {
  const levels: Span[] = props.rungs.flatMap((level, index) => [
    ...(index === 0 ? [] : [{ text: EFFORT_GAP }]),
    ...(level === props.effort
      ? [{ text: `${glyph.marker}${EFFORT_ABBREVIATION[level]}`, fg: theme.court.external }]
      : [{ text: EFFORT_ABBREVIATION[level], fg: theme.hint }]),
  ])
  const gap = Math.max(GAP_CELLS, props.cells - spanCells(levels) - cellsOf(EFFORT_AFFORDANCE))

  return (
    <TextLine
      spans={[...levels, { text: ' '.repeat(gap) }, { text: EFFORT_AFFORDANCE, fg: theme.hint }]}
      cells={props.cells}
    />
  )
}

const THIS_THREAD: readonly Span[] = [
  { text: `${glyph.swap} `, fg: theme.accent },
  { text: 'next turn', fg: theme.hover },
  { text: ' · this conversation only', fg: theme.hint },
]

const EVERY_NEW_THREAD: readonly Span[] = [
  { text: `${glyph.swap} `, fg: theme.accent },
  { text: 'the default', fg: theme.hover },
  { text: ' · every new conversation', fg: theme.hint },
]

const QUICK_CALLS: readonly Span[] = [
  { text: `${glyph.swap} `, fg: theme.accent },
  { text: 'quick calls', fg: theme.hover },
  { text: ' · tl;dr, titles and the judge', fg: theme.hint },
]

const appliesSpans = (target: SwitcherTarget): readonly Span[] => {
  if (target.scope === EModelScope.Thread) return THIS_THREAD
  if (target.id === ESettingId.ModelId) return EVERY_NEW_THREAD
  return QUICK_CALLS
}

export function AppliesLine(props: { cells: number; target: SwitcherTarget }): React.ReactNode {
  return <TextLine spans={appliesSpans(props.target)} cells={props.cells} />
}
