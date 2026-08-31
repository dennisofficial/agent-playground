import { EKilledBy } from '../shells/status'

export enum EAgentStatus {
  Running = 'running',
  Finished = 'finished',
  Failed = 'failed',
  Stopped = 'stopped',
  Blocked = 'blocked',
}

export type AgentEnding = {
  status: EAgentStatus
  turns: number
  toolCalls: number
  killedBy?: EKilledBy | undefined
}

export const countedNoun = ({ count, noun }: { count: number; noun: string }): string =>
  count === 1 ? `1 ${noun}` : `${count} ${noun}s`

const effort = (ending: AgentEnding): string =>
  `${countedNoun({ count: ending.turns, noun: 'turn' })} and ${countedNoun({ count: ending.toolCalls, noun: 'tool call' })}`

export const attributedStop = ({
  status,
  killedBy,
}: {
  status: EAgentStatus
  killedBy: EKilledBy | undefined
}): EKilledBy | undefined => (status === EAgentStatus.Stopped ? killedBy : undefined)

function stopped(killedBy: EKilledBy | undefined): string {
  if (killedBy === EKilledBy.User) return 'was stopped by the user after'
  if (killedBy === EKilledBy.Model) return 'was stopped at your request after'
  if (killedBy === EKilledBy.SessionEnd) return 'was stopped when the session closed, after'
  if (killedBy === EKilledBy.Unrecorded) {
    return 'was lost before anything recorded how it ended, after'
  }
  return 'was stopped after'
}

function outcome(ending: AgentEnding): string {
  if (ending.status === EAgentStatus.Failed) return 'failed after'
  if (ending.status === EAgentStatus.Stopped) return stopped(ending.killedBy)
  if (ending.status === EAgentStatus.Running) return 'is still running after'
  if (ending.status === EAgentStatus.Blocked) {
    return 'is blocked on an approval it cannot answer, after'
  }
  return 'finished after'
}

export function agentEnding(ending: AgentEnding): string {
  return `${outcome(ending)} ${effort(ending)}`
}
