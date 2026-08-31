import { describe, expect, it } from 'bun:test'

import { agentEnding, EAgentStatus } from '../status'

const ending = (over: Partial<Parameters<typeof agentEnding>[0]> = {}) => ({
  status: EAgentStatus.Finished,
  turns: 4,
  toolCalls: 11,
  ...over,
})

describe('the sentence a parent reads about a delegate that stopped', () => {
  it('counts the work rather than quoting it', () => {
    expect(agentEnding(ending())).toBe('finished after 4 turns and 11 tool calls')
  })

  it('says a failure failed', () => {
    expect(agentEnding(ending({ status: EAgentStatus.Failed }))).toBe(
      'failed after 4 turns and 11 tool calls',
    )
  })

  it('says a stopped agent was stopped, not that it finished', () => {
    expect(agentEnding(ending({ status: EAgentStatus.Stopped }))).toBe(
      'was stopped after 4 turns and 11 tool calls',
    )
  })

  it('never claims a still-running agent is done', () => {
    expect(agentEnding(ending({ status: EAgentStatus.Running }))).toBe(
      'is still running after 4 turns and 11 tool calls',
    )
  })

  it('counts one turn and one tool call in the singular', () => {
    expect(agentEnding(ending({ turns: 1, toolCalls: 1 }))).toBe(
      'finished after 1 turn and 1 tool call',
    )
  })

  it('counts a delegate that did nothing at all', () => {
    expect(agentEnding(ending({ turns: 0, toolCalls: 0 }))).toBe(
      'finished after 0 turns and 0 tool calls',
    )
  })
})
