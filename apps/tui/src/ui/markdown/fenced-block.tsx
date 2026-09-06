import React, { useMemo, useState } from 'react'

import { Panel, PANEL_INSET, PANEL_PAD } from '../components/panel'
import { wrapsFence } from '../fence-wrap-store'
import { ALT, theme } from '../theme'
import { COPY_BUTTON_WIDTH, CopyButton } from './copy-button'
import { rendererFor } from './registry'
import { TextPanner } from './text-panner'

export const CONTENT_PADDING = PANEL_PAD

const CHROME = PANEL_INSET + PANEL_PAD

const RIGHT_MARGIN = 2

const SEPARATOR = ' · '

export function fenceColumns(source: string): number {
  return Math.max(0, ...source.split('\n').map((line) => line.length))
}

/**
 * What a fence would claim on its own, without rendering it. Every renderer reports `columns` as the
 * longest line, so this is exact for the numbered ones and a gutter too wide for a diff — which only
 * ever levels a block up, never past the room it has.
 */
export function fenceWidth(args: {
  language: string
  filename?: string
  source: string
  width: number
}): number {
  const available = Math.max(4, args.width - RIGHT_MARGIN)
  return Math.min(
    available,
    Math.max(
      fenceColumns(args.source) + gutterWidth(args.source) + CHROME,
      headerColumns(args),
    ),
  )
}

export function FencedBlock(props: {
  language: string
  filename?: string
  source: string
  width: number
  streaming?: boolean
  attached?: boolean
  levelled?: number
}): React.ReactNode {
  const [pointerInside, setPointerInside] = useState(false)

  // CodeRenderable's `streaming` setter discards its highlight, so moving the flag under a
  // mounted block redraws it as plain text for the round trip the replacement highlight takes —
  // the flash a streamed fence showed when prose arrived behind it or the message ended. The
  // mount-time value stands for the life of the block.
  const [streaming] = useState(() => props.streaming === true)

  const available = Math.max(4, props.width - RIGHT_MARGIN)
  const wrap = wrapsFence(props.language)
  const gutter = useMemo(() => gutterWidth(props.source), [props.source])
  const lead = wrap ? 0 : gutter

  const view = useMemo(
    () =>
      rendererFor(props.language).render({
        source: props.source,
        language: props.language,
        width: Math.max(1, available - CHROME - lead),
        streaming,
        wrap,
      }),
    [props.language, props.source, available, lead, streaming, wrap],
  )

  const numbered = !wrap && view.numbered !== false
  const natural = Math.max(view.columns + lead + CHROME, headerColumns(props))
  const outer = Math.min(available, Math.max(natural, props.levelled ?? 0))
  const inner = Math.max(1, outer - CHROME - lead)
  const overflows = !wrap && view.columns > inner

  return (
    <box
      flexDirection="column"
      marginBottom={props.attached === true ? 0 : 1}
      width={outer}
      flexShrink={0}
      onMouseOver={() => setPointerInside(true)}
      onMouseOut={() => setPointerInside(false)}
    >
      <Panel
        rail={theme.rule}
        fill={theme.panelBg}
        width={outer}
        {...(named(props)
          ? {
              band: theme.panelBand,
              header: (
                <>
                  <text fg={theme.meta} flexShrink={0}>
                    {props.language}
                  </text>
                  {props.filename ? (
                    <text flexShrink={0}>
                      <span fg={theme.rule}>{SEPARATOR}</span>
                      <span fg={theme.hint}>{props.filename}</span>
                    </text>
                  ) : null}
                  <box flexGrow={1} />
                  <CopyButton text={props.source} revealed={pointerInside} />
                </>
              ),
            }
          : {
              badge: (
                <CopyButton
                  text={props.source}
                  revealed={pointerInside}
                  bg={theme.panelBg}
                />
              ),
            })}
      >
        <box flexDirection="row" flexShrink={0}>
          {numbered ? <Gutter rows={view.rows} width={gutter} /> : null}
          {overflows ? (
            <TextPanner columns={view.columns} width={inner} rows={view.rows}>
              {view.node as React.ReactElement}
            </TextPanner>
          ) : (
            view.node
          )}
        </box>

        {overflows ? <text fg={theme.hint}>{`⇄ ${ALT}+wheel`}</text> : null}
      </Panel>
    </box>
  )
}

function Gutter(props: { rows: number; width: number }): React.ReactNode {
  const digits = props.width - 1
  const numbers = Array.from({ length: props.rows }, (_, index) =>
    String(index + 1).padStart(digits),
  ).join('\n')

  return (
    <text fg={theme.meta} wrapMode="none" width={props.width} flexShrink={0}>
      {numbers}
    </text>
  )
}

export function gutterWidth(source: string): number {
  return String(source.split('\n').length).length + 1
}

const named = (props: { language: string; filename?: string }): boolean =>
  props.language.length > 0 || (props.filename ?? '').length > 0

function headerColumns(props: { language: string; filename?: string }): number {
  const label =
    props.language.length + (props.filename ? SEPARATOR.length + props.filename.length : 0)
  return PANEL_INSET + label + 2 + COPY_BUTTON_WIDTH + PANEL_PAD
}
