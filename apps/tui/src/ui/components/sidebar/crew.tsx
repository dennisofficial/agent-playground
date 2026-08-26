import React from 'react'

import type { SidebarSubagent, SidebarTeammate } from '../../../store/sidebar-model'
import { glyph, theme } from '../../theme'
import { Row, Section } from './row'

const IDLE = 'idle'

const AWAITING_APPROVAL = '? approval'

export function SubagentsSection(props: {
  subagents: readonly SidebarSubagent[]
  cells: number
}): React.ReactNode {
  if (props.subagents.length === 0) return null

  return (
    <Section label="Subagents" count={String(props.subagents.length)}>
      {props.subagents.map((subagent) => (
        <Row
          key={subagent.id}
          label={subagent.name}
          labelFg={theme.hover}
          cells={props.cells}
          mark={{ text: glyph.active, fg: theme.court.external }}
          value={
            subagent.awaitingApproval
              ? [{ text: AWAITING_APPROVAL, fg: theme.warn }]
              : [{ text: `${subagent.calls} calls`, fg: theme.hint }]
          }
        />
      ))}
    </Section>
  )
}

export function TeammatesSection(props: {
  teammates: readonly SidebarTeammate[]
  cells: number
}): React.ReactNode {
  if (props.teammates.length === 0) return null

  return (
    <Section label="Teammates" count={String(props.teammates.length)}>
      {props.teammates.map((teammate) => (
        <Row
          key={teammate.id}
          label={teammate.name}
          labelFg={theme.hover}
          cells={props.cells}
          mark={{ text: glyph.unseen, fg: teammate.activity === null ? theme.rule : theme.ok }}
          value={[{ text: teammate.activity ?? IDLE, fg: theme.hint }]}
        />
      ))}
    </Section>
  )
}
