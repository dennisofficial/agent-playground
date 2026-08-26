import React from 'react'

import {
  CONTEXT_BAR_CELLS,
  CONTEXT_BAR_GLYPH,
  contextBarCells,
  contextTone,
} from '../context-bar'
import {
  FOOTER_GUTTER,
  footerLayout,
  type FooterContext,
  type FooterEffort,
  type FooterInstruments,
  type FooterReadout,
} from '../footer-layout'
import { HINT_SEPARATOR } from '../hint-layout'
import { theme } from '../theme'
import { Spans, type Span } from './spans'

export type { FooterContext, FooterEffort }

function separated(groups: readonly (readonly Span[])[]): Span[] {
  return groups
    .filter((group) => group.length > 0)
    .flatMap((group, index) => [
      ...(index === 0 ? [] : [{ text: HINT_SEPARATOR, fg: theme.rule }]),
      ...group,
    ])
}

function tinted(args: { text: string; fg: string }): Span[] {
  return args.text
    .split(HINT_SEPARATOR)
    .flatMap((piece, index) => [
      ...(index === 0 ? [] : [{ text: HINT_SEPARATOR, fg: theme.rule }]),
      { text: piece, fg: args.fg },
    ])
}

function barSpans(args: { percent: number; cells: number }): Span[] {
  const bar = contextBarCells(args)
  return [
    { text: CONTEXT_BAR_GLYPH.repeat(bar.ok), fg: theme.ok },
    { text: CONTEXT_BAR_GLYPH.repeat(bar.warn), fg: theme.warn },
    { text: CONTEXT_BAR_GLYPH.repeat(bar.empty), fg: theme.rule },
  ].filter((span) => span.text.length > 0)
}

function readoutSpans(args: {
  readout: FooterReadout
  percent: number
  cells: number
}): Span[] {
  const tone = contextTone(args.percent)
  const text = tinted({ text: args.readout.text, fg: tone })
  if (!args.readout.bar) return text
  return [...barSpans({ percent: args.percent, cells: args.cells }), { text: ' ' }, ...text]
}

function factSpans(args: { instruments: FooterInstruments }): Span[][] {
  const { model, effort } = args.instruments
  return [
    model === null ? [] : [{ text: model, fg: theme.hover }],
    effort === null ? [] : [{ text: effort, fg: theme.court.external }],
  ]
}

export function Footer(props: {
  width: number
  model: string
  effort?: FooterEffort | null
  context?: FooterContext | null
  barCells?: number
}): React.ReactNode {
  const cells = props.barCells ?? CONTEXT_BAR_CELLS
  const layout = footerLayout({
    width: props.width,
    model: props.model,
    barCells: cells,
    ...(props.effort === undefined ? {} : { effort: props.effort }),
    ...(props.context === undefined ? {} : { context: props.context }),
  })
  const readout = layout.instruments.context
  const context =
    readout === null || props.context === undefined || props.context === null
      ? []
      : readoutSpans({ readout, percent: props.context.percent, cells })

  return (
    <box flexDirection="row" flexShrink={0} paddingLeft={FOOTER_GUTTER} paddingRight={FOOTER_GUTTER}>
      <text>
        <Spans spans={separated([...factSpans({ instruments: layout.instruments }), context])} />
      </text>
    </box>
  )
}
