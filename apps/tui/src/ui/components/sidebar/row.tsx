import React from 'react'

import { theme } from '../../theme'
import { Spans, type Span } from '../spans'
import { clipSpans, fitLabel, spanCells } from './cells'

const COUNT_SEPARATOR = '  '

export function Row(props: {
  label: string
  labelFg: string
  cells: number
  mark?: Span
  value?: readonly Span[]
}): React.ReactNode {
  const markSpans = props.mark === undefined ? [] : [props.mark, { text: ' ' }]
  const cells = Math.max(0, props.cells - spanCells(markSpans))
  const value = clipSpans({ spans: props.value ?? [], cells })
  const label = fitLabel({ label: props.label, valueCells: spanCells(value), cells })

  return (
    <text>
      <Spans spans={[...markSpans, { text: label, fg: props.labelFg }, ...value]} />
    </text>
  )
}

export function Section(props: {
  label: string
  count?: string
  children: React.ReactNode
}): React.ReactNode {
  return (
    <box flexDirection="column" flexShrink={0}>
      <text>
        <Spans
          spans={[
            { text: props.label.toUpperCase(), fg: theme.meta },
            ...(props.count === undefined
              ? []
              : [{ text: `${COUNT_SEPARATOR}${props.count}`, fg: theme.hint }]),
          ]}
        />
      </text>
      {props.children}
    </box>
  )
}
