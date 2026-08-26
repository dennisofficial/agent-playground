import React from 'react'

import { modelLabel } from '../../model-label'
import { collapseHome } from '../../paths'
import { glyph, theme } from '../../theme'

const WORDMARK = 'atlas'

const PITCH = 'A coding agent working in this directory.'

const ACTION = 'Describe the work below.'

export function WelcomeBlock(props: { cwd: string; home: string; modelId: string }): React.ReactNode {
  return (
    <box flexDirection="column" marginBottom={1} flexShrink={0}>
      <text>
        <span fg={theme.accent}>{glyph.block} </span>
        <span fg={theme.hover}>{WORDMARK}</span>
      </text>
      <text> </text>
      <text fg={theme.meta}>{`  ${PITCH}`}</text>
      <text> </text>
      <text fg={theme.hint}>{`  ${collapseHome({ cwd: props.cwd, home: props.home })}`}</text>
      <text fg={theme.hint}>{`  ${modelLabel(props.modelId)}`}</text>
      <text> </text>
      <text fg={theme.meta}>{`  ${ACTION}`}</text>
    </box>
  )
}
