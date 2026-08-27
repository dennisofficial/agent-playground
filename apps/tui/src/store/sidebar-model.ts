import {
  eventsOfType,
  outstandingApproval,
  pendingCalls,
  type CallId,
  type Event,
} from '@dltech/atlas-core'

import { sidebarCells, truncateCells } from '../ui/components/sidebar/cells'
import type { TurnClock } from '../ui/components/transcript'
import { SIDEBAR_WIDTH } from '../ui/theme'

export type SidebarToolCall = { callId: CallId; name: string }

export type SidebarApproval = { callId: CallId; reason: string }

export type SidebarGit = { branch: string }

export type SidebarPullRequest = { number: number; state: string }

export type SidebarChecks = { running: number; passed: number; failed: number }

export enum ESidebarTaskState {
  Done = 'done',
  Running = 'running',
  Pending = 'pending',
}

export type SidebarTask = { id: string; label: string; state: ESidebarTaskState }

export type SidebarSubagent = {
  id: string
  name: string
  calls: number
  awaitingApproval: boolean
}

export type SidebarTeammate = { id: string; name: string; activity: string | null }

export type SidebarModel = {
  title: string | null
  turnCount: number
  totalTokens: number
  approvals: readonly SidebarApproval[]
  toolCalls: readonly SidebarToolCall[]
  lastActivity: string | null
  liveOutputTokens: number
  lastTurnOutputTokens: number | null
  git?: SidebarGit
  pr?: SidebarPullRequest
  ci?: SidebarChecks
  todo?: readonly SidebarTask[]
  subagents?: readonly SidebarSubagent[]
  teammates?: readonly SidebarTeammate[]
}

export const IDLE_SIDEBAR: SidebarModel = {
  title: null,
  turnCount: 0,
  totalTokens: 0,
  approvals: [],
  toolCalls: [],
  lastActivity: null,
  liveOutputTokens: 0,
  lastTurnOutputTokens: null,
}

const TITLE_CELLS = sidebarCells({ width: SIDEBAR_WIDTH })

const approvalNames = (events: readonly Event[]): SidebarApproval[] => {
  const outstanding = outstandingApproval(events)
  if (outstanding === undefined) return []

  const requested = eventsOfType({ events, type: 'approval-requested' }).find(
    (event) => event.callId === outstanding,
  )
  if (requested === undefined) return []

  return [{ callId: outstanding, reason: requested.reason }]
}

const oneLineOf = (text: string): string | null => {
  const oneLine = text.replace(/\s+/g, ' ').trim()
  return oneLine.length === 0 ? null : oneLine
}

const nameOrOpening = (args: { events: readonly Event[]; name: string | null }): string | null => {
  const named = args.name === null ? null : oneLineOf(args.name)
  if (named !== null) return named

  const opening = eventsOfType({ events: args.events, type: 'user-said' }).at(0)
  return opening === undefined ? null : oneLineOf(opening.text)
}

const titleOf = (args: { events: readonly Event[]; name: string | null }): string | null => {
  const title = nameOrOpening(args)
  return title === null ? null : truncateCells({ text: title, cells: TITLE_CELLS })
}

export function deriveSidebar(args: {
  events: readonly Event[]
  turn: TurnClock
  name?: string | null | undefined
}): SidebarModel {
  const { events, turn } = args
  const name = args.name ?? null

  const running = turn.startedAt !== null
  const liveOutputTokens = running ? turn.outputTokens : 0
  const lastTurnOutputTokens = running ? null : (turn.completed?.outputTokens ?? null)

  const awaitingApproval = outstandingApproval(events)

  return {
    title: titleOf({ events, name }),
    turnCount: eventsOfType({ events, type: 'user-said' }).length,
    totalTokens: liveOutputTokens + (lastTurnOutputTokens ?? 0),
    approvals: approvalNames(events),
    toolCalls: pendingCalls(events)
      .filter((call) => call.callId !== awaitingApproval)
      .map((call) => ({ callId: call.callId, name: call.name })),
    lastActivity: events.at(-1)?.at ?? null,
    liveOutputTokens,
    lastTurnOutputTokens,
  }
}
