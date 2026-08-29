import React from 'react'

import { ESidebarTaskState, type SidebarTask } from '../../../store/sidebar-model'
import { glyph, theme } from '../../theme'
import { ETodoRow, todoRows, type TodoRow } from '../../todo-layout'
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

export function TodoSection(props: {
  tasks: readonly SidebarTask[]
  cells: number
}): React.ReactNode {
  if (props.tasks.length === 0) return null

  const done = props.tasks.filter((task) => task.state === ESidebarTaskState.Done).length

  return (
    <Section label="Todo" count={`${done}/${props.tasks.length}`}>
      {todoRows({ tasks: props.tasks, cells: props.cells }).map((row) => (
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
