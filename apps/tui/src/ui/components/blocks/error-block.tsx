import React from 'react'

import { useClickRegion } from '../../hooks/use-click-region'
import { glyph, theme } from '../../theme'

export function ErrorBlock(props: {
  title: string
  detail?: string
  onRetry?: () => void
}): React.ReactNode {
  const retry = useClickRegion(props.onRetry)
  const label = ` ${glyph.retry} retry `

  return (
    <box flexDirection="column" marginBottom={1}>
      <text fg={theme.error}>
        {glyph.block} {props.title}
      </text>
      {props.detail ? (
        <text>
          {'  '}
          <span fg={theme.dim}>{glyph.result}</span>
          {'  '}
          <span fg={theme.dim}>{props.detail}</span>
        </text>
      ) : null}
      {props.onRetry ? (
        <box flexDirection="row">
          <text fg={theme.dim}>{`  ${glyph.result} `}</text>
          <text {...retry.handlers}>
            <span fg={retry.hovered ? theme.hover : theme.dim} {...retry.wash}>
              {label}
            </span>
          </text>
        </box>
      ) : null}
    </box>
  )
}
