import { BorderChars } from '@opentui/core'
import React, { useMemo, useState } from 'react'

import { ALT, theme } from '../theme'
import { COPY_BUTTON_WIDTH, CopyButton } from './copy-button'
import { rendererFor } from './registry'
import { TextPanner } from './text-panner'

const BORDER = 2

export const CONTENT_PADDING = 1

const CHROME = BORDER + CONTENT_PADDING * 2

const RIGHT_MARGIN = 2

const CHARS = BorderChars.rounded

export function FencedBlock(props: {
  language: string
  source: string
  width: number
}): React.ReactNode {
  const [pointerInside, setPointerInside] = useState(false)

  const available = Math.max(4, props.width - RIGHT_MARGIN)

  const view = useMemo(
    () =>
      rendererFor(props.language).render({
        source: props.source,
        language: props.language,
        width: Math.max(1, available - CHROME),
      }),
    [props.language, props.source, available],
  )

  const outer = Math.min(available, Math.max(view.columns + CHROME, headerColumns(props.language)))
  const inner = Math.max(1, outer - CHROME)
  const overflows = view.columns > inner

  return (
    <box
      flexDirection="column"
      marginBottom={1}
      width={outer}
      flexShrink={0}
      onMouseOver={() => setPointerInside(true)}
      onMouseOut={() => setPointerInside(false)}
    >
      <FenceHeader
        language={props.language}
        source={props.source}
        width={outer}
        revealed={pointerInside}
      />

      <box
        flexDirection="column"
        border={['left', 'right', 'bottom']}
        borderStyle="rounded"
        borderColor={theme.dim}
        paddingX={CONTENT_PADDING}
      >
        {overflows ? (
          <TextPanner columns={view.columns} width={inner} rows={view.rows}>
            {view.node as React.ReactElement}
          </TextPanner>
        ) : (
          view.node
        )}

        {overflows ? (
          <text fg={theme.dim}>{`⇄ ${ALT}+wheel · ${view.columns} cols`}</text>
        ) : null}
      </box>
    </box>
  )
}

function headerLabel(language: string): string {
  return language.length > 0
    ? `${CHARS.topLeft}${CHARS.horizontal} ${language} `
    : CHARS.topLeft
}

function headerColumns(language: string): number {
  return headerLabel(language).length + COPY_BUTTON_WIDTH + 2
}

function FenceHeader(props: {
  language: string
  source: string
  width: number
  revealed: boolean
}): React.ReactNode {
  const label = headerLabel(props.language)
  const right = `${CHARS.horizontal}${CHARS.topRight}`
  const fill = props.width - label.length - COPY_BUTTON_WIDTH - right.length

  if (fill < 0) {
    return (
      <text fg={theme.dim}>
        {label +
          CHARS.horizontal.repeat(Math.max(0, props.width - label.length - 1)) +
          CHARS.topRight}
      </text>
    )
  }

  return (
    <box flexDirection="row" width={props.width}>
      <text fg={theme.dim}>{label + CHARS.horizontal.repeat(fill)}</text>
      <CopyButton text={props.source} pad={CHARS.horizontal} revealed={props.revealed} />
      <text fg={theme.dim}>{right}</text>
    </box>
  )
}
