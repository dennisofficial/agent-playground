import React from 'react'
import { homedir } from 'node:os'

import type { AgentTypeCatalog } from '@dltech/atlas-harness'

import {
  agentTypeCount,
  agentTypeSections,
  catalogIsEmpty,
  EAgentTypeSection,
  NOTHING_ON_DISK,
  type AgentTypeRow,
  type AgentTypeSection,
} from '../agent-types-model'
import { cellsOf } from '../hint-layout'
import { collapseHome, tailOfPath } from '../paths'
import { theme } from '../theme'
import { Panel, PANEL_INSET, PANEL_PAD } from './panel'
import { truncateCells, wrapCells } from './sidebar/cells'

const CHROME_COLUMNS = PANEL_INSET + PANEL_PAD

const NAME_GAP = 2

const WIDEST_NAME = 20

const NAME_INK_OF: Record<EAgentTypeSection, string> = {
  [EAgentTypeSection.Refused]: theme.warn,
  [EAgentTypeSection.Shadowed]: theme.warn,
  [EAgentTypeSection.Loaded]: theme.court.external,
}

const DETAIL_INK_OF: Record<EAgentTypeSection, string> = {
  [EAgentTypeSection.Refused]: theme.body,
  [EAgentTypeSection.Shadowed]: theme.body,
  [EAgentTypeSection.Loaded]: theme.hint,
}

const nameColumnCells = (sections: readonly AgentTypeSection[]): number => {
  const widest = sections.flatMap((section) =>
    section.rows.map((row) => cellsOf(row.name)),
  )
  return Math.min(WIDEST_NAME, Math.max(0, ...widest)) + NAME_GAP
}

/**
 * The path gets a line of its own rather than a share of the detail's: a refusal the operator
 * cannot act on because the file was elided says no more than nothing did, and the tail is the end
 * that names the file.
 */
function WhereLine(props: { path: string; indent: number; cells: number }): React.ReactNode {
  const room = Math.max(0, props.cells - props.indent)
  const shown = tailOfPath({
    path: collapseHome({ cwd: props.path, home: homedir() }),
    cells: room,
  })

  return (
    <text>
      <span>{' '.repeat(props.indent)}</span>
      <span fg={theme.dim}>{shown}</span>
    </text>
  )
}

function TypeRow(props: {
  row: AgentTypeRow
  kind: EAgentTypeSection
  nameCells: number
  cells: number
}): React.ReactNode {
  const { row } = props
  const room = Math.max(0, props.cells - props.nameCells)
  const lines = wrapCells({ text: row.detail, cells: room })
  const name = truncateCells({ text: row.name, cells: props.nameCells - NAME_GAP })
  const pad = ' '.repeat(Math.max(1, props.nameCells - cellsOf(name)))

  return (
    <box flexDirection="column" flexShrink={0}>
      <text>
        <span fg={NAME_INK_OF[props.kind]}>{name}</span>
        <span>{pad}</span>
        <span fg={DETAIL_INK_OF[props.kind]}>{lines.at(0) ?? ''}</span>
      </text>
      {lines.slice(1).map((line) => (
        <text key={line}>
          <span>{' '.repeat(props.nameCells)}</span>
          <span fg={DETAIL_INK_OF[props.kind]}>{line}</span>
        </text>
      ))}
      {row.definedIn === null ? null : (
        <WhereLine path={row.definedIn} indent={props.nameCells} cells={props.cells} />
      )}
    </box>
  )
}

function Section(props: {
  section: AgentTypeSection
  nameCells: number
  cells: number
}): React.ReactNode {
  return (
    <box flexDirection="column" flexShrink={0}>
      <text fg={theme.meta}>{props.section.title.toUpperCase()}</text>
      {props.section.rows.map((row) => (
        <TypeRow
          key={`${row.name}-${row.definedIn ?? ''}`}
          row={row}
          kind={props.section.kind}
          nameCells={props.nameCells}
          cells={props.cells}
        />
      ))}
    </box>
  )
}

/**
 * A refusal is not an error state of the app — boot survived and the other files loaded — so this
 * reads as a listing that happens to carry bad news, not as an alarm.
 */
export function AgentTypes(props: {
  width: number
  catalog: AgentTypeCatalog
}): React.ReactNode {
  const sections = agentTypeSections(props.catalog)
  const cells = Math.max(0, props.width - CHROME_COLUMNS)
  const nameCells = nameColumnCells(sections)

  return (
    <Panel
      width={props.width}
      fill={theme.overlayBg}
      label={<text fg={theme.meta} bg={theme.overlayBg}>{' Agent types '}</text>}
      badge={
        <text fg={theme.hint} bg={theme.overlayBg}>{` ${agentTypeCount(props.catalog)} `}</text>
      }
    >
      <box flexDirection="column" flexShrink={0} gap={1}>
        {catalogIsEmpty(props.catalog) ? (
          <text fg={theme.hint}>{truncateCells({ text: NOTHING_ON_DISK, cells })}</text>
        ) : (
          sections.map((section) => (
            <Section
              key={section.kind}
              section={section}
              nameCells={nameCells}
              cells={cells}
            />
          ))
        )}
      </box>
    </Panel>
  )
}
