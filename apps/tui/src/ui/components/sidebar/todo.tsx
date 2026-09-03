import React, { useState } from 'react'

import { ESidebarTaskState, type SidebarTask } from '../../../store/sidebar-model'
import { useClickRegion } from '../../hooks/use-click-region'
import { glyph, theme } from '../../theme'
import { ETodoRow, foldTodo, todoRows, type TodoRow } from '../../todo-layout'
import type { Span } from '../spans'
import { Row, Section } from './row'

const DONE = '✓'

const INDENT: Span = { text: ' ' }

const markOf = (row: TodoRow): Span => {
  if (row.kind !== ETodoRow.Head) return INDENT
  if (row.state === ESidebarTaskState.Done) return { text: DONE, fg: theme.ok }
  if (row.state === ESidebarTaskState.Running) return { text: glyph.marker, fg: theme.warn }

  return { text: glyph.available, fg: theme.hint }
}

const labelFgOf = (row: TodoRow): string =>
  row.state === ESidebarTaskState.Running ? theme.bright : theme.hint

function DoneFoldRow(props: {
  hidden: number
  expanded: boolean
  onToggle: () => void
}): React.ReactNode {
  const region = useClickRegion(props.onToggle)

  return (
    <text wrapMode="none" flexShrink={0} {...region.handlers}>
      <span fg={theme.ok} {...region.wash}>
        {`${DONE} `}
      </span>
      <span fg={region.hovered ? theme.hover : theme.hint} {...region.wash}>
        {`${props.hidden} more done ${props.expanded ? '▾' : '▸'}`}
      </span>
    </text>
  )
}

export function TodoSection(props: {
  tasks: readonly SidebarTask[]
  cells: number
}): React.ReactNode {
  const [expanded, setExpanded] = useState(false)
  if (props.tasks.length === 0) return null

  const done = props.tasks.filter((task) => task.state === ESidebarTaskState.Done).length
  const fold = foldTodo({ tasks: props.tasks, expanded })

  return (
    <Section label="Todo" count={`${done}/${props.tasks.length}`}>
      {fold.hidden === 0 ? null : (
        <DoneFoldRow
          hidden={fold.hidden}
          expanded={expanded}
          onToggle={() => setExpanded((value) => !value)}
        />
      )}
      {todoRows({ tasks: fold.shown, cells: props.cells }).map((row) => (
        <Row
          key={row.key}
          label={row.text}
          labelFg={labelFgOf(row)}
          cells={props.cells}
          mark={markOf(row)}
        />
      ))}
    </Section>
  )
}
