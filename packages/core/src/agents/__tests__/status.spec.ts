import { describe, expect, it } from 'bun:test'

import { EKilledBy } from '../../shells/status'
import { agentEnding, attributedStop, EAgentStatus } from '../status'

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

  it('says a blocked child is blocked on an approval, not that someone stopped it', () => {
    expect(agentEnding(ending({ status: EAgentStatus.Blocked }))).toBe(
      'is blocked on an approval it cannot answer, after 4 turns and 11 tool calls',
    )
  })

  it('names the operator when the operator stopped it', () => {
    expect(agentEnding(ending({ status: EAgentStatus.Stopped, killedBy: EKilledBy.User }))).toBe(
      'was stopped by the user after 4 turns and 11 tool calls',
    )
  })

  it('reminds the parent when the parent stopped it', () => {
    expect(agentEnding(ending({ status: EAgentStatus.Stopped, killedBy: EKilledBy.Model }))).toBe(
      'was stopped at your request after 4 turns and 11 tool calls',
    )
  })

  it('says teardown stopped it, so a reopened session does not read it as a decision', () => {
    expect(
      agentEnding(ending({ status: EAgentStatus.Stopped, killedBy: EKilledBy.SessionEnd })),
    ).toBe('was stopped when the session closed, after 4 turns and 11 tool calls')
  })

  it('lets an unattributed stop stay unattributed', () => {
    expect(agentEnding(ending({ status: EAgentStatus.Stopped }))).toBe(
      'was stopped after 4 turns and 11 tool calls',
    )
  })

  it('says a lost child was lost, never that anyone stopped it', () => {
    const sentence = agentEnding(
      ending({ status: EAgentStatus.Stopped, killedBy: EKilledBy.Unrecorded }),
    )

    expect(sentence).toBe(
      'was lost before anything recorded how it ended, after 4 turns and 11 tool calls',
    )
    expect(sentence).not.toContain('stopped')
  })

  it('never lets an attribution contradict the status it is attached to', () => {
    expect(agentEnding(ending({ status: EAgentStatus.Blocked, killedBy: EKilledBy.User }))).toBe(
      'is blocked on an approval it cannot answer, after 4 turns and 11 tool calls',
    )
    expect(agentEnding(ending({ status: EAgentStatus.Finished, killedBy: EKilledBy.User }))).toBe(
      'finished after 4 turns and 11 tool calls',
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

describe('the attribution an ending is allowed to record', () => {
  it('keeps who stopped an agent that was stopped', () => {
    expect(attributedStop({ status: EAgentStatus.Stopped, killedBy: EKilledBy.User })).toBe(
      EKilledBy.User,
    )
  })

  it('drops it from every other ending, which nobody stopped', () => {
    for (const status of [EAgentStatus.Finished, EAgentStatus.Failed, EAgentStatus.Blocked]) {
      expect(attributedStop({ status, killedBy: EKilledBy.User })).toBeUndefined()
    }
  })
})
