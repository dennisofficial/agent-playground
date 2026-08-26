import React from 'react'

import type { SidebarChecks, SidebarModel } from '../../../store/sidebar-model'
import { useShimmerClock } from '../../hooks/use-shimmer-clock'
import { formatTokens, spinnerFrame, theme, SPINNER_FRAME_MS } from '../../theme'
import type { Span } from '../spans'
import { truncateCells } from './cells'
import { Row } from './row'

const PASSED = '✓'

const FAILED = '✗'

const GROUP_SEPARATOR = '  '

const turnsAndTokens = (model: SidebarModel): string => {
  const turns = `${model.turnCount} ${model.turnCount === 1 ? 'turn' : 'turns'}`
  if (model.totalTokens === 0) return turns
  return `${turns} · ${formatTokens(model.totalTokens)} tokens`
}

/**
 * No model and no conversation branch: the footer carries what is answering, and a fork of the
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

const checkSpans = (args: { ci: SidebarChecks; now: number }): Span[] => {
  const { ci } = args
  const running: Span[] =
    ci.running === 0
      ? []
      : [{ text: `${spinnerFrame(args.now)} ${ci.running} running`, fg: theme.warn }]
  const passed: Span[] =
    ci.passed === 0 ? [] : [{ text: `${ci.passed} ${PASSED}`, fg: theme.ok }]
  const failed: Span[] =
    ci.failed === 0 ? [] : [{ text: `${ci.failed} ${FAILED}`, fg: theme.error }]

  return [running, passed, failed]
    .filter((group) => group.length > 0)
    .flatMap((group, index) => (index === 0 ? group : [{ text: GROUP_SEPARATOR }, ...group]))
}

function ChecksRow(props: { ci: SidebarChecks; cells: number }): React.ReactNode {
  const now = useShimmerClock({ active: props.ci.running > 0, intervalMs: SPINNER_FRAME_MS })
  const value = checkSpans({ ci: props.ci, now })
  if (value.length === 0) return null

  return <Row label="ci" labelFg={theme.meta} cells={props.cells} value={value} />
}

export function FactsSection(props: { model: SidebarModel; cells: number }): React.ReactNode {
  const { git, pr, ci } = props.model
  if (git === undefined && pr === undefined && ci === undefined) return null

  return (
    <box flexDirection="column" flexShrink={0}>
      {git === undefined ? null : (
        <Row
          label="git"
          labelFg={theme.meta}
          cells={props.cells}
          value={[{ text: git.branch, fg: theme.hover }]}
        />
      )}
      {pr === undefined ? null : (
        <Row
          label="pr"
          labelFg={theme.meta}
          cells={props.cells}
          value={[
            { text: `#${pr.number}`, fg: theme.code },
            { text: ` ${pr.state}`, fg: theme.meta },
          ]}
        />
      )}
      {ci === undefined ? null : <ChecksRow ci={ci} cells={props.cells} />}
    </box>
  )
}
