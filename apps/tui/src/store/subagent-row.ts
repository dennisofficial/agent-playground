import { EAgentStatus, contextPressure } from '@dltech/atlas-core'
import type { AgentSnapshot, ChildContext } from '@dltech/atlas-harness'

import { truncateCells } from '../ui/components/sidebar/cells'
import { formatElapsed, formatTokens } from '../ui/theme'
import { ESpendReading, type AgentSpend } from './agent-spend'
import { TITLE_CELLS, oneLineOf } from './sidebar-text'
import { plural } from './tools/reading'

export type SubagentReadout = {
  status: EAgentStatus
  calls: number
  lastTool: string | null
  startedAt: string
  endedAt: string | null
}

export type SidebarSubagent = SubagentReadout & {
  id: string
  name: string
  state: string
  spend: AgentSpend | null
  context?: ChildContext | undefined
  selected: boolean
}

export type SidebarCrewFold = { hidden: number; hiddenFailed: boolean }

export const subagentLabel = (snapshot: Pick<AgentSnapshot, 'intent' | 'agentType'>): string => {
  const intent = oneLineOf(snapshot.intent)
  return truncateCells({ text: intent ?? snapshot.agentType, cells: TITLE_CELLS })
}

export const isSubagentRunning = (subagent: Pick<SidebarSubagent, 'status'>): boolean =>
  subagent.status === EAgentStatus.Running

const SUBAGENT_WENT_WRONG: Record<EAgentStatus, boolean> = {
  [EAgentStatus.Running]: false,
  [EAgentStatus.Blocked]: false,
  [EAgentStatus.Finished]: false,
  [EAgentStatus.Failed]: true,
  [EAgentStatus.Stopped]: true,
}

export const subagentWentWrong = (subagent: Pick<SidebarSubagent, 'status'>): boolean =>
  SUBAGENT_WENT_WRONG[subagent.status]

/**
 * What the narrow value column spends its cells on. A child that is still going is judged by what
 * it is doing and for how long; one that has settled is judged by how much it got through.
 */
export enum ESubagentReading {
  Live = 'live',
  Held = 'held',
  Settled = 'settled',
}

const SUBAGENT_READING: Record<EAgentStatus, ESubagentReading> = {
  [EAgentStatus.Running]: ESubagentReading.Live,
  [EAgentStatus.Blocked]: ESubagentReading.Held,
  [EAgentStatus.Finished]: ESubagentReading.Settled,
  [EAgentStatus.Failed]: ESubagentReading.Settled,
  [EAgentStatus.Stopped]: ESubagentReading.Settled,
}

const SUBAGENT_STATE_LABEL: Record<EAgentStatus, string> = {
  [EAgentStatus.Running]: 'running',
  [EAgentStatus.Blocked]: 'blocked',
  [EAgentStatus.Finished]: 'done',
  [EAgentStatus.Failed]: 'failed',
  [EAgentStatus.Stopped]: 'stopped',
}

export const subagentReading = (subagent: Pick<SidebarSubagent, 'status'>): ESubagentReading =>
  SUBAGENT_READING[subagent.status]

export const subagentShowsElapsed = (subagent: Pick<SidebarSubagent, 'status'>): boolean =>
  subagentReading(subagent) !== ESubagentReading.Settled

const instantOf = (iso: string): number | null => {
  const at = Date.parse(iso)
  return Number.isNaN(at) ? null : at
}

export function subagentElapsedMs(args: {
  subagent: Pick<SubagentReadout, 'startedAt' | 'endedAt'>
  now: number
}): number | null {
  const started = instantOf(args.subagent.startedAt)
  if (started === null) return null

  const ended = args.subagent.endedAt === null ? null : instantOf(args.subagent.endedAt)
  return Math.max(0, (ended ?? args.now) - started)
}

const READOUT_SEPARATOR = ' · '

const stateWord = (subagent: Pick<SubagentReadout, 'status'>): string =>
  SUBAGENT_STATE_LABEL[subagent.status]

const callsWord = (calls: number): string | null => (calls === 0 ? null : plural(calls, 'call'))

type ReadoutParts = { subagent: SubagentReadout; since: string | null }

const SUBAGENT_READOUT: Record<
  ESubagentReading,
  (parts: ReadoutParts) => readonly (string | null)[]
> = {
  [ESubagentReading.Live]: ({ subagent, since }) => [subagent.lastTool, since],
  [ESubagentReading.Held]: ({ subagent, since }) => [stateWord(subagent), since],
  [ESubagentReading.Settled]: ({ subagent }) => [stateWord(subagent), callsWord(subagent.calls)],
}

export function subagentStateLabel(args: { subagent: SubagentReadout; now: number }): string {
  const { subagent } = args
  const elapsed = subagentElapsedMs({ subagent, now: args.now })
  const parts = SUBAGENT_READOUT[subagentReading(subagent)]({
    subagent,
    since: elapsed === null ? null : formatElapsed(elapsed),
  })

  const written = parts.filter((part): part is string => part !== null).join(READOUT_SEPARATOR)
  return written === '' ? stateWord(subagent) : written
}

/**
 * Counted from the supervisor's own reading of the child rather than from the composed event list,
 * which belongs to whichever thread is open and would lend an untitled child the parent's work.
 */
export const SPEND_UNAVAILABLE_LABEL = 'tokens unavailable'

const FIGURE_SEPARATOR = '  '

/**
 * Both directions are shown because input dominates a child's bill and output alone would flatter
 * it. Cache reads and writes are already counted inside `inputTokens`.
 */
export function subagentSpendLabel(spend: AgentSpend | null): string | null {
  if (spend === null) return null
  if (spend.reading === ESpendReading.Unavailable) return SPEND_UNAVAILABLE_LABEL

  const { inputTokens, outputTokens } = spend.totals
  if (inputTokens === 0 && outputTokens === 0) return null

  return `↑ ${formatTokens(inputTokens)}${FIGURE_SEPARATOR}↓ ${formatTokens(outputTokens)}`
}

/**
 * A child's own window, never added to the parent's: a child may run a different model, so the two
 * are different windows and a sum of them would make the parent's remaining context read as a lie.
 * A window nothing has sized is unreadable rather than empty.
 */
export function subagentContextLabel(context: ChildContext | undefined): string | null {
  if (context === undefined) return null
  if (context.window <= 0) return null

  const pressure = contextPressure({ used: context.tokens, window: context.window })
  return `ctx ${pressure.percent}%`
}

export function subagentFigures(
  subagent: Pick<SidebarSubagent, 'spend' | 'context'>,
): string | null {
  const written = [subagentSpendLabel(subagent.spend), subagentContextLabel(subagent.context)]
    .filter((figure): figure is string => figure !== null)
    .join(FIGURE_SEPARATOR)

  return written === '' ? null : written
}

export const subagentSpendIsUnavailable = (spend: AgentSpend | null): boolean =>
  spend !== null && spend.reading === ESpendReading.Unavailable

export function subagentRows(args: {
  snapshots: readonly AgentSnapshot[]
  now: number
  spend?: ReadonlyMap<string, AgentSpend> | undefined
  viewing?: string | null | undefined
}): readonly SidebarSubagent[] {
  return args.snapshots.map((snapshot) => {
    const readout: SubagentReadout = {
      status: snapshot.status,
      calls: snapshot.toolCalls,
      lastTool: snapshot.lastTool ?? null,
      startedAt: snapshot.startedAt,
      endedAt: snapshot.endedAt ?? null,
    }

    return {
      ...readout,
      id: snapshot.agentId,
      name: subagentLabel(snapshot),
      state: subagentStateLabel({ subagent: readout, now: args.now }),
      spend: args.spend?.get(snapshot.agentId) ?? null,
      context: snapshot.context,
      selected: snapshot.agentId === args.viewing,
    }
  })
}
