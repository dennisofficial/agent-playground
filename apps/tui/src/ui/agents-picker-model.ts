import type { ESubagentReading } from '../store/subagent-row'

export const AGENT_PICKER_ROWS = 8

export type AgentPickerRow = {
  agentId: string
  name: string
  state: string
  tone: ESubagentReading
}

export type AgentsPickerState = {
  rows: readonly AgentPickerRow[]
  index: number
}

export type AgentsPickerWindow = {
  start: number
  visible: readonly AgentPickerRow[]
  below: number
}

const clamped = (args: { value: number; count: number }): number =>
  Math.min(Math.max(0, args.value), Math.max(0, args.count - 1))

export const openedAgents = (args: { rows: readonly AgentPickerRow[] }): AgentsPickerState => ({
  rows: args.rows,
  index: 0,
})

export function moveAgentSelection(args: {
  state: AgentsPickerState
  delta: number
}): AgentsPickerState {
  const count = args.state.rows.length
  if (count === 0) return args.state

  return {
    ...args.state,
    index: clamped({ value: args.state.index + Math.trunc(args.delta), count }),
  }
}

export const selectedAgent = (state: AgentsPickerState): AgentPickerRow | undefined =>
  state.rows[state.index]

export function agentsWindow(args: { state: AgentsPickerState; rows: number }): AgentsPickerWindow {
  const rows = Math.max(1, Math.trunc(args.rows))
  const held = args.state.rows
  if (held.length <= rows) return { start: 0, visible: held, below: 0 }

  const start = Math.min(Math.max(0, args.state.index - rows + 1), held.length - rows)
  return { start, visible: held.slice(start, start + rows), below: held.length - start - rows }
}
