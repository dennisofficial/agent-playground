import React from 'react'

import { contextTone } from '../context-bar'
import {
  FOOTER_GUTTER,
  footerLayout,
  type FooterContext,
  type FooterEffort,
  type FooterInstruments,
  type FooterReadout,
} from '../footer-layout'
import { HINT_SEPARATOR } from '../hint-layout'
import { meterTone } from '../meter-tone'
import { theme } from '../theme'
import type { FooterMeter } from '../usage-meters'
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

function meterSpans(meters: readonly FooterMeter[]): Span[] {
  return meters.flatMap((meter) => [
    { text: HINT_SEPARATOR, fg: theme.rule },
    { text: `${meter.label} `, fg: theme.rule },
    { text: meter.text, fg: meterTone(meter.band) },
  ])
}

function readoutSpans(args: { readout: FooterReadout; percent: number }): Span[] {
  return [
    ...tinted({ text: args.readout.text, fg: contextTone(args.percent) }),
    ...meterSpans(args.readout.meters),
  ]
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
}): React.ReactNode {
  const layout = footerLayout({
    width: props.width,
    model: props.model,
    ...(props.effort === undefined ? {} : { effort: props.effort }),
    ...(props.context === undefined ? {} : { context: props.context }),
  })
  const readout = layout.instruments.context
  const context =
    readout === null || props.context === undefined || props.context === null
      ? []
      : readoutSpans({ readout, percent: props.context.percent })

  const facts = separated(factSpans({ instruments: layout.instruments }))

  return (
    <box flexDirection="row" flexShrink={0} paddingLeft={FOOTER_GUTTER} paddingRight={FOOTER_GUTTER}>
      <text>
        <Spans spans={facts} />
      </text>
      <box flexGrow={1} />
      <text>
        <Spans spans={context} />
      </text>
    </box>
  )
}
