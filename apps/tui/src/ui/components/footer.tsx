import React from 'react'

import { contextTone } from '../context-bar'
import type { FooterItem } from '../footer-item'
import {
  FOOTER_GUTTER,
  footerLayout,
  isMeasured,
  type FooterContext,
  type FooterLayout,
  type FooterReadout,
} from '../footer-layout'
import type { FooterStripState } from '../footer-strip'
import { useAppearance } from '../hooks/use-appearance'
import { meterTone } from '../meter-tone'
import { theme } from '../theme'
import type { FooterMeter } from '../usage-meters'
import { FooterStrip } from './footer-strip'
import { Spans, type Span } from './spans'

export type { FooterContext }

function meterSpans(meters: readonly FooterMeter[]): Span[] {
  return meters.flatMap((meter) => [
    { text: ' ' },
    { text: `${meter.label} `, fg: theme.rule },
    { text: meter.text, fg: meterTone(meter.band) },
  ])
}

function readoutSpans(args: { readout: FooterReadout; context: FooterContext }): Span[] {
  const fg = isMeasured(args.context) ? contextTone(args.context.percent) : theme.warn
  return [{ text: args.readout.text, fg }, ...meterSpans(args.readout.meters)]
}

function DerivedFooter(props: {
  width: number
  items?: readonly FooterItem[]
  context?: FooterContext | null
  strip?: FooterStripState | null
  layout?: FooterLayout
  onActivateItem?: (item: FooterItem) => void
}): React.ReactNode {
  useAppearance()
  const layout =
    props.layout ??
    footerLayout({
      width: props.width,
      ...(props.items === undefined ? {} : { items: props.items }),
      ...(props.context === undefined ? {} : { context: props.context }),
    })
  const readout = layout.instruments.context
  const context =
    readout === null || props.context === undefined || props.context === null
      ? []
      : readoutSpans({ readout, context: props.context })

  return (
    <box
      flexDirection="row"
      flexShrink={0}
      paddingLeft={FOOTER_GUTTER}
      paddingRight={FOOTER_GUTTER}
    >
      <FooterStrip
        items={layout.instruments.items}
        selectedId={props.strip?.itemId ?? null}
        {...(props.onActivateItem === undefined ? {} : { onActivate: props.onActivateItem })}
      />
      <box flexGrow={1} />
      <text flexShrink={0}>
        <Spans spans={context} />
      </text>
    </box>
  )
}

export const Footer = React.memo(DerivedFooter)
