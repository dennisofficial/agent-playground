import React from 'react'

import { ESidebarTaskState, type SidebarTask } from '../../../store/sidebar-model'
import { useShimmerClock } from '../../hooks/use-shimmer-clock'
import { glyph, spinnerFrame, theme, SPINNER_FRAME_MS } from '../../theme'
import type { Span } from '../spans'
import { Row, Section } from './row'

const DONE = '✓'

const markOf = (args: { state: ESidebarTaskState; now: number }): Span => {
  if (args.state === ESidebarTaskState.Done) return { text: DONE, fg: theme.ok }
  if (args.state === ESidebarTaskState.Running)
    return { text: spinnerFrame(args.now), fg: theme.warn }
  return { text: glyph.available, fg: theme.hint }
}

const labelFgOf = (state: ESidebarTaskState): string =>
  state === ESidebarTaskState.Running ? theme.bright : theme.hint

export function TodoSection(props: {
  tasks: readonly SidebarTask[]
  cells: number
}): React.ReactNode {
  const running = props.tasks.some((task) => task.state === ESidebarTaskState.Running)
  const now = useShimmerClock({ active: running, intervalMs: SPINNER_FRAME_MS })

  if (props.tasks.length === 0) return null

  const done = props.tasks.filter((task) => task.state === ESidebarTaskState.Done).length

  return (
    <Section label="Todo" count={`${done}/${props.tasks.length}`}>
      {props.tasks.map((task) => (
        <Row
          key={task.id}
          label={task.label}
          labelFg={labelFgOf(task.state)}
          cells={props.cells}
          mark={markOf({ state: task.state, now })}
        />
      ))}
    </Section>
  )
}
