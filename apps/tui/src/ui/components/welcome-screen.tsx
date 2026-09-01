import React from 'react'

import { modelLabel } from '../model-label'
import { collapseHome } from '../paths'
import { glyph, theme } from '../theme'
import { wordmarkRows, WORDMARK_CELLS } from '../wordmark'
import { Spans } from './spans'

const WORDMARK = 'atlas'

const PITCH = 'A coding agent working in this directory.'

const ACTION = 'Describe the work below.'

const SEPARATOR = ' · '

export function WelcomeScreen(props: {
  cwd: string
  home: string
  modelId: string
  width: number
}): React.ReactNode {
  const marked = props.width >= WORDMARK_CELLS
  const rows = wordmarkRows({ accent: theme.accent, ground: theme.appBg, bright: theme.bright })

  return (
    <box flexDirection="column" flexShrink={0} alignItems="center">
      {marked ? (
        <box flexDirection="column" flexShrink={0} width={WORDMARK_CELLS}>
          {rows.map((row, index) => (
            <box key={index} height={1} flexShrink={0}>
              <text>
                <Spans spans={row} />
              </text>
            </box>
          ))}
        </box>
      ) : (
        <text>
          <span fg={theme.accent}>{glyph.block} </span>
          <span fg={theme.hover}>{WORDMARK}</span>
        </text>
      )}
      <text> </text>
      <text fg={theme.meta}>{PITCH}</text>
      <text> </text>
      <text>
        <span fg={theme.hint}>{collapseHome({ cwd: props.cwd, home: props.home })}</span>
        <span fg={theme.rule}>{SEPARATOR}</span>
        <span fg={theme.hint}>{modelLabel(props.modelId)}</span>
      </text>
      <text> </text>
      <text fg={theme.meta}>{ACTION}</text>
      <text> </text>
    </box>
  )
}
