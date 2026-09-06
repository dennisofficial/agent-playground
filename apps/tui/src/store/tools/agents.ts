import { EAgentStatus } from '@dltech/atlas-core'

import { ECallState, type ToolCall } from '../tool-runs'
import { EDetail, EToolClass, type Classification } from './kinds'
import { count, detailOf, inputOf, outputOf, plural, records, str } from './reading'

const AGENT_LINE: Record<string, (named: string) => string> = {
  agent_spawn: (named) => `Spawned ${named}`,
  agent_say: (named) => `Messaged ${named}`,
  agent_resume: (named) => `Resumed ${named}`,
  agent_stop: (named) => `Stopped ${named}`,
}

const STOP_NOTE: Record<EAgentStatus, string> = {
  [EAgentStatus.Running]: 'stopping',
  [EAgentStatus.Finished]: 'already done',
  [EAgentStatus.Failed]: 'already failed',
  [EAgentStatus.Stopped]: 'already stopped',
  [EAgentStatus.Blocked]: 'blocked',
}

const STILL_OUT: Record<EAgentStatus, boolean> = {
  [EAgentStatus.Running]: true,
  [EAgentStatus.Blocked]: true,
  [EAgentStatus.Finished]: false,
  [EAgentStatus.Failed]: false,
  [EAgentStatus.Stopped]: false,
}

const statusOf = (value: unknown): EAgentStatus | undefined =>
  Object.values(EAgentStatus).find((status) => status === value)

const stopNote = (call: ToolCall): string => {
  const status = statusOf(outputOf(call).status)
  return status === undefined ? 'stopped' : STOP_NOTE[status]
}

const AGENT_NOTE: Record<string, (call: ToolCall) => string> = {
  agent_spawn: () => 'running',
  agent_say: (call) => (outputOf(call).queued === true ? 'queued' : 'running'),
  agent_resume: () => 'running',
  agent_stop: stopNote,
}

const agentNameOf = (args: { call: ToolCall; cwd: string }): string => {
  const input = inputOf(args.call)
  const intent = str(input.intent)
  if (intent !== undefined && intent.trim() !== '') return intent.trim()

  return str(input.agentType) ?? str(input.agentId) ?? 'a sub-agent'
}

type Tally = { listed: number; running: number; blocked: number; ended: number }

function tallied(call: ToolCall): Tally {
  const listed = records(outputOf(call).agents)
  const statuses = listed.map((agent) => statusOf(agent.status))

  return {
    listed: listed.length,
    running: statuses.filter((status) => status === EAgentStatus.Running).length,
    blocked: statuses.filter((status) => status === EAgentStatus.Blocked).length,
    ended: statuses.filter((status) => status !== undefined && !STILL_OUT[status]).length,
  }
}

function listedNote(tally: Tally): string {
  if (tally.listed === 0) return 'none'
  if (tally.blocked > 0) return `${count(tally.blocked)} blocked`
  if (tally.running > 0) return `${count(tally.running)} running`
  if (tally.ended === tally.listed) return `${count(tally.ended)} ended`
  return plural(tally.listed, 'sub-agent')
}

function agentListing(call: ToolCall): Classification {
  const tally = tallied(call)

  return {
    klass: EToolClass.External,
    gather: null,
    line: 'Checked on the sub-agents',
    failed: call.state !== ECallState.Ok,
    note: call.state === ECallState.Ok ? listedNote(tally) : 'failed',
    metric: tally.listed,
    detail: EDetail.Output,
  }
}

export function agentCall(args: { call: ToolCall; cwd: string }): Classification | null {
  const { call } = args

  if (call.name === 'agent_list') return agentListing(call)

  const phrase = AGENT_LINE[call.name]
  const noted = AGENT_NOTE[call.name]
  if (phrase === undefined || noted === undefined) return null

  return {
    klass: EToolClass.External,
    gather: null,
    line: phrase(agentNameOf(args)),
    failed: call.state !== ECallState.Ok,
    note: call.state === ECallState.Ok ? noted(call) : 'failed',
    metric: null,
    detail: detailOf(call).length > 0 ? EDetail.Output : EDetail.None,
  }
}
