import React from 'react'

import { modelLabel } from '../../model-label'
import { collapseHome } from '../../paths'
import { glyph, theme, TRANSCRIPT_INSET } from '../../theme'
import { wordmarkRows, WORDMARK_CELLS } from '../../wordmark'
import { Spans } from '../spans'

const WORDMARK = 'atlas'

const PITCH = 'A coding agent working in this directory.'

const ACTION = 'Describe the work below.'

const INDENT = '  '

const SEPARATOR = ' · '

const TOP_AIR = 1

export function WelcomeBlock(props: {
  cwd: string
  home: string
  modelId: string
  width: number
}): React.ReactNode {
  const marked = props.width >= WORDMARK_CELLS + INDENT.length + TRANSCRIPT_INSET
  const rows = wordmarkRows({ accent: theme.accent, ground: theme.appBg, bright: theme.bright })

  return (
    <box flexDirection="column" marginTop={TOP_AIR} marginBottom={1} flexShrink={0}>
      {marked ? (
        rows.map((row, index) => (
          <text key={index}>
            <span>{INDENT}</span>
            <Spans spans={row} />
          </text>
        ))
      ) : (
        <text>
          <span fg={theme.accent}>{glyph.block} </span>
          <span fg={theme.hover}>{WORDMARK}</span>
        </text>
      )}
      <text> </text>
      <text fg={theme.meta}>{`${INDENT}${PITCH}`}</text>
      <text> </text>
      <text>
        <span fg={theme.hint}>
          {`${INDENT}${collapseHome({ cwd: props.cwd, home: props.home })}`}
        </span>
        <span fg={theme.rule}>{SEPARATOR}</span>
        <span fg={theme.hint}>{modelLabel(props.modelId)}</span>
      </text>
      <text> </text>
      <text fg={theme.meta}>{`${INDENT}${ACTION}`}</text>
    </box>
  )
}
