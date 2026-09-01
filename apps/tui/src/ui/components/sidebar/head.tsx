import React from 'react'

import type { SidebarModel } from '../../../store/sidebar-model'
import { formatTokens, theme } from '../../theme'
import { truncateCells } from './cells'

const turnsAndTokens = (model: SidebarModel): string => {
  const turns = `${model.turnCount} ${model.turnCount === 1 ? 'turn' : 'turns'}`
  if (model.totalTokens === 0) return turns
  return `${turns} · ${formatTokens(model.totalTokens)} tokens`
}

/**
 * No model and no thread: the footer carries what is answering, and a fork of the
 * conversation belongs to the session picker rather than here — this says `git` instead.
 */
export function HeadSection(props: { model: SidebarModel; cells: number }): React.ReactNode {
  const { model } = props
  if (model.title === null && model.turnCount === 0) return null

  return (
    <box flexDirection="column" flexShrink={0}>
      {model.title === null ? null : (
        <text fg={theme.bright}>{truncateCells({ text: model.title, cells: props.cells })}</text>
      )}
      {model.turnCount === 0 ? null : (
        <text fg={theme.hint}>
          {truncateCells({ text: turnsAndTokens(model), cells: props.cells })}
        </text>
      )}
    </box>
  )
}
