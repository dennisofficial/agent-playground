import { homedir } from 'node:os'

import React from 'react'

import { collapseHome, tailOfPath } from '../paths'
import { theme } from '../theme'
import type { SidebarModel } from '../../store'
import { sidebarCells } from './sidebar/cells'
import { SubagentsSection, TeammatesSection } from './sidebar/crew'
import { FactsSection, HeadSection } from './sidebar/head'
import { TodoSection } from './sidebar/todo'
import { ApprovalsSection, ToolCallsSection, TurnSection } from './sidebar/turn'
import type { TurnClock } from './transcript'

export enum ESidebarPreference {
  Auto = 'auto',
  Hidden = 'hidden',
}

function SidebarFooter(props: { cwd: string; cells: number }): React.ReactNode {
  const where = collapseHome({ cwd: props.cwd, home: homedir() })

  return (
    <box flexDirection="column" flexShrink={0} paddingTop={1}>
      <text fg={theme.dim}>{tailOfPath({ path: where, cells: props.cells })}</text>
      <text>
        <span fg={theme.accent}>● </span>
        <span fg={theme.hover}>atlas</span>
      </text>
    </box>
  )
}

export function Sidebar(props: {
  width: number
  model: SidebarModel
  turn: TurnClock
  now: number
  cwd: string
  overlay?: boolean
}): React.ReactNode {
  const { model } = props
  const cells = sidebarCells({ width: props.width })

  return (
    <box
      flexDirection="column"
      flexShrink={0}
      width={props.width}
      backgroundColor={theme.panelBg}
      paddingTop={1}
      paddingBottom={1}
      paddingLeft={2}
      paddingRight={2}
      {...(props.overlay
        ? { position: 'absolute' as const, top: 0, bottom: 0, right: 0, zIndex: 20 }
        : {})}
    >
      <scrollbox flexGrow={1} flexShrink={1} flexBasis={0}>
        <box flexDirection="column" flexShrink={0} gap={1}>
          <HeadSection model={model} cells={cells} />
          <FactsSection model={model} cells={cells} />
          <TurnSection turn={props.turn} now={props.now} cells={cells} />
          <ApprovalsSection model={model} cells={cells} />
          <ToolCallsSection model={model} cells={cells} />
          <TodoSection tasks={model.todo ?? []} cells={cells} />
          <SubagentsSection subagents={model.subagents ?? []} cells={cells} />
          <TeammatesSection teammates={model.teammates ?? []} cells={cells} />
        </box>
      </scrollbox>
      <SidebarFooter cwd={props.cwd} cells={cells} />
    </box>
  )
}
