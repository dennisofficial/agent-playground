import { homedir } from 'node:os'

import { RGBA } from '@opentui/core'
import React from 'react'

import { collapseHome, tailOfPath } from '../paths'
import { theme } from '../theme'
import type { ShellSnapshot } from '@dltech/atlas-harness'

import type { SidebarModel } from '../../store'
import type { SidebarCrewFold } from '../../store/subagent-row'
import { SIDEBAR_GUTTER, SIDEBAR_PADDING, sidebarCells } from './sidebar/cells'
import { SubagentsSection, TeammatesSection } from './sidebar/crew'
import { FactsSection, HeadSection } from './sidebar/head'
import { ShellsSection } from './sidebar/shells'
import { TodoSection } from './sidebar/todo'
import { ApprovalsSection, TurnSection } from './sidebar/turn'
import type { TurnClock } from './transcript'

function SidebarFooter(props: { cwd: string; cells: number }): React.ReactNode {
  const where = collapseHome({ cwd: props.cwd, home: homedir() })

  return (
    <box flexDirection="column" flexShrink={0} paddingTop={1} paddingRight={SIDEBAR_GUTTER}>
      <text fg={theme.dim}>{tailOfPath({ path: where, cells: props.cells })}</text>
      <text>
        <span fg={theme.accent}>● </span>
        <span fg={theme.hover}>atlas</span>
      </text>
    </box>
  )
}

const SCRIM = RGBA.fromInts(0, 0, 0, 70)

/**
 * The scrim is the floating sidebar's sibling rather than its parent so that folding and unfolding
 * never re-parents the panel, which would remount the scrollbox and lose where it was scrolled to.
 */
function Scrim(): React.ReactNode {
  return (
    <box
      position="absolute"
      zIndex={19}
      top={0}
      bottom={0}
      left={0}
      right={0}
      backgroundColor={SCRIM}
    />
  )
}

/**
 * Every positioning prop is passed on every render rather than spread in only while floating:
 * OpenTUI's reconciler applies the props an element carries and leaves a prop that disappeared
 * from it at its last value, so a sidebar that stopped floating would stay out of the flow and
 * the transcript would keep the whole terminal and draw underneath it.
 */
export function Sidebar(props: {
  width: number
  model: SidebarModel
  turn: TurnClock
  now: number
  cwd: string
  overlay?: boolean
  shells?: readonly ShellSnapshot[]
  shellFold?: SidebarCrewFold
  onOpenShell?: (shellId: string) => void
  onSelectSubagent?: (agentId: string) => void
}): React.ReactNode {
  const { model } = props
  const cells = sidebarCells({ width: props.width })
  const floating = props.overlay === true

  return (
    <>
      {floating ? <Scrim /> : null}
      <box
        flexDirection="column"
        flexShrink={0}
        width={props.width}
        backgroundColor={theme.panelBg}
        paddingTop={1}
        paddingBottom={1}
        paddingLeft={SIDEBAR_PADDING}
        position={floating ? 'absolute' : 'relative'}
        zIndex={floating ? 20 : 0}
        top={0}
        bottom={0}
        right={0}
      >
        <scrollbox
          flexGrow={1}
          flexShrink={1}
          flexBasis={0}
          contentOptions={{ paddingRight: SIDEBAR_PADDING }}
        >
          <box flexDirection="column" flexShrink={0} gap={1}>
            <HeadSection model={model} cells={cells} />
            <FactsSection model={model} cells={cells} />
            <TurnSection turn={props.turn} now={props.now} cells={cells} />
            <ApprovalsSection model={model} cells={cells} />
            <ShellsSection
              shells={props.shells ?? []}
              cells={cells}
              fold={props.shellFold}
              {...(props.onOpenShell === undefined ? {} : { onOpen: props.onOpenShell })}
            />
            <TodoSection tasks={model.todo ?? []} cells={cells} />
            <SubagentsSection
              subagents={model.subagents ?? []}
              cells={cells}
              fold={model.crewFold}
              {...(props.onSelectSubagent === undefined ? {} : { onOpen: props.onSelectSubagent })}
            />
            <TeammatesSection teammates={model.teammates ?? []} cells={cells} />
          </box>
        </scrollbox>
        <SidebarFooter cwd={props.cwd} cells={cells} />
      </box>
    </>
  )
}
