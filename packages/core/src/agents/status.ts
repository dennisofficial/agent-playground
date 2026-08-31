export enum EAgentStatus {
  Running = 'running',
  Finished = 'finished',
  Failed = 'failed',
  Stopped = 'stopped',
}

export type AgentEnding = {
  status: EAgentStatus
  turns: number
  toolCalls: number
}

export const countedNoun = ({ count, noun }: { count: number; noun: string }): string =>
  count === 1 ? `1 ${noun}` : `${count} ${noun}s`

const effort = (ending: AgentEnding): string =>
  `${countedNoun({ count: ending.turns, noun: 'turn' })} and ${countedNoun({ count: ending.toolCalls, noun: 'tool call' })}`

function outcome(status: EAgentStatus): string {
  if (status === EAgentStatus.Failed) return 'failed after'
  if (status === EAgentStatus.Stopped) return 'was stopped after'
  if (status === EAgentStatus.Running) return 'is still running after'
  return 'finished after'
}

export function agentEnding(ending: AgentEnding): string {
  return `${outcome(ending.status)} ${effort(ending)}`
}
