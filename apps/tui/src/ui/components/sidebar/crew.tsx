import React from 'react'

import { type SidebarTeammate } from '../../../store/sidebar-model'
import {
  isSubagentRunning,
  subagentFigures,
  subagentReading,
  subagentSpendIsUnavailable,
  type SidebarCrewFold,
  type SidebarSubagent,
} from '../../../store/subagent-row'
import { plural } from '../../../store/tools/reading'
import { usePress } from '../../hooks/use-press'
import { cellsOf } from '../../hint-layout'
import { MARK_OF, NAME_INK_OF, STATE_INK_OF } from '../../subagent-ink'
import { glyph, theme } from '../../theme'
import { truncateCells } from './cells'
import { Row, Section } from './row'

const IDLE = 'idle'

const markFor = (subagent: SidebarSubagent) => MARK_OF[subagentReading(subagent)]

const labelFor = (subagent: SidebarSubagent): string => {
  if (subagent.selected) return theme.court.external
  return NAME_INK_OF[subagentReading(subagent)]
}

const valueFor = (subagent: SidebarSubagent) => [
  { text: subagent.state, fg: STATE_INK_OF[subagentReading(subagent)] },
]

/**
 * A second line, and only when there is a reading to put on it. What the child cost and how full
 * its own window has got are worth the row's height in every state — running, blocked and settled
 * alike — but an empty one would spend the height on nothing, which in a panel this narrow is
 * what makes a crew unreadable.
 *
 * Hung off the same right edge `Row` ends its value column on, so the two lines read as one row and
 * the figures stack into a column the eye can run down a whole crew. A window reading joins to the
 * right of the output count, growing the line leftwards into the empty half.
 */
function FiguresLine(props: { subagent: SidebarSubagent; cells: number }): React.ReactNode {
  const label = subagentFigures(props.subagent)
  if (label === null) return null

  const shown = truncateCells({ text: label, cells: props.cells })
  const lead = ' '.repeat(Math.max(0, props.cells - cellsOf(shown)))

  return (
    <text>
      <span>{lead}</span>
      <span fg={subagentSpendIsUnavailable(props.subagent.spend) ? theme.rule : theme.dim}>
        {shown}
      </span>
    </text>
  )
}

/**
 * What the panel let go of, kept as one line rather than a heading of its own. The reading names
 * `/agents` because a retired child is still whole — the rows leave the sidebar, nothing leaves
 * the roster or the log.
 */
function RetiredLine(props: { fold: SidebarCrewFold; cells: number }): React.ReactNode {
  return (
    <Row
      label={`${plural(props.fold.hidden, 'more')} in /agents`}
      labelFg={theme.rule}
      cells={props.cells}
      mark={{ text: glyph.seen, fg: theme.rule }}
      {...(props.fold.hiddenFailed ? { value: [{ text: 'one failed', fg: theme.warn }] } : {})}
    />
  )
}

/**
 * Selecting a row moves the transcript alone, so the highlight is the only thing that says where
 * the operator is reading — the rest of this panel still describes the thread that spawned them.
 */
export function SubagentsSection(props: {
  subagents: readonly SidebarSubagent[]
  cells: number
  fold?: SidebarCrewFold | undefined
  onOpen?: (agentId: string) => void
}): React.ReactNode {
  const press = usePress()
  if (props.subagents.length === 0) return null

  const running = props.subagents.filter(isSubagentRunning).length
  const total = props.subagents.length + (props.fold?.hidden ?? 0)

  return (
    <Section label="Subagents" count={`${running}/${total}`}>
      {props.subagents.map((subagent) => (
        <box
          key={subagent.id}
          flexDirection="column"
          flexShrink={0}
          {...(subagent.selected ? { backgroundColor: theme.userBg } : {})}
          {...press(props.onOpen === undefined ? undefined : () => props.onOpen?.(subagent.id))}
        >
          <Row
            label={subagent.name}
            labelFg={labelFor(subagent)}
            cells={props.cells}
            mark={markFor(subagent)}
            value={valueFor(subagent)}
          />
          <FiguresLine subagent={subagent} cells={props.cells} />
        </box>
      ))}
      {props.fold === undefined ? null : <RetiredLine fold={props.fold} cells={props.cells} />}
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
