import {
  EPlanStatus,
  eventsOfType,
  outstandingApproval,
  planFromEvents,
  type CallId,
  type Event,
} from '@dltech/atlas-core'

import { truncateCells } from '../ui/components/sidebar/cells'
import type { TurnClock } from '../ui/components/transcript'
import { TITLE_CELLS, oneLineOf } from './sidebar-text'
import type { SidebarCrewFold, SidebarSubagent } from './subagent-row'

export type SidebarApproval = { callId: CallId; reason: string }

export type SidebarGit = { branch: string }

export type SidebarPullRequest = { number: number; state: string }

export type SidebarChecks = { running: number; passed: number; failed: number }

export enum ESidebarTaskState {
  Done = 'done',
  Running = 'running',
  Pending = 'pending',
}

export type SidebarTask = {
  id: string
  label: string
  state: ESidebarTaskState
  activeForm?: string | undefined
}

export type SidebarTeammate = { id: string; name: string; activity: string | null }

export type SidebarModel = {
  title: string | null
  turnCount: number
  totalTokens: number
  approvals: readonly SidebarApproval[]
  lastActivity: string | null
  liveOutputTokens: number
  lastTurnOutputTokens: number | null
  git?: SidebarGit
  pr?: SidebarPullRequest
  ci?: SidebarChecks
  todo?: readonly SidebarTask[]
  subagents?: readonly SidebarSubagent[]
  crewFold?: SidebarCrewFold
  teammates?: readonly SidebarTeammate[]
}

export const IDLE_SIDEBAR: SidebarModel = {
  title: null,
  turnCount: 0,
  totalTokens: 0,
  approvals: [],
  lastActivity: null,
  liveOutputTokens: 0,
  lastTurnOutputTokens: null,
}

const approvalNames = (events: readonly Event[]): SidebarApproval[] => {
  const outstanding = outstandingApproval(events)
  if (outstanding === undefined) return []

  const requested = eventsOfType({ events, type: 'approval-requested' }).find(
    (event) => event.callId === outstanding,
  )
  if (requested === undefined) return []

  return [{ callId: outstanding, reason: requested.reason }]
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

const TASK_STATE_OF: Record<EPlanStatus, ESidebarTaskState> = {
  [EPlanStatus.Pending]: ESidebarTaskState.Pending,
  [EPlanStatus.InProgress]: ESidebarTaskState.Running,
  [EPlanStatus.Completed]: ESidebarTaskState.Done,
}

const todoOf = (events: readonly Event[]): readonly SidebarTask[] =>
  planFromEvents(events).map((task) => ({
    id: String(task.ordinal),
    label: task.text,
    state: TASK_STATE_OF[task.status],
    ...(task.activeForm === undefined ? {} : { activeForm: task.activeForm }),
  }))

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

  const todo = todoOf(events)

  return {
    title: titleOf({ events, name }),
    turnCount: eventsOfType({ events, type: 'user-said' }).length,
    totalTokens: liveOutputTokens + (lastTurnOutputTokens ?? 0),
    approvals: approvalNames(events),
    lastActivity: events.at(-1)?.at ?? null,
    liveOutputTokens,
    lastTurnOutputTokens,
    ...(todo.length === 0 ? {} : { todo }),
  }
}

/**
 * A crew with nothing left to show takes its heading with it rather than leaving a tally behind:
 * the whole point of retiring a row is the cells it gives back, and `/agents` is where a settled
 * child is read from once the panel has let it go.
 */
export function withCrew(args: {
  model: SidebarModel
  subagents: readonly SidebarSubagent[]
  fold?: SidebarCrewFold
}): SidebarModel {
  const { model, subagents } = args
  if (subagents.length === 0) return model

  const fold = args.fold
  if (fold === undefined || fold.hidden === 0) return { ...model, subagents }

  return { ...model, subagents, crewFold: fold }
}
