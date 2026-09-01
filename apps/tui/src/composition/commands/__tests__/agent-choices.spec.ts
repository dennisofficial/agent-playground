import { EAgentStatus, type ThreadId } from '@dltech/atlas-core'
import type { AgentSnapshot } from '@dltech/atlas-harness'
import { describe, expect, it } from 'bun:test'

import { ESubagentReading } from '../../../store/subagent-row'
import { agentChoiceName, agentChoices, agentHasSettled } from '../agent-choices'

const PARENT = 'parent' as ThreadId

const child = (args: {
  id: string
  status: EAgentStatus
  startedAt: string
  endedAt?: string
  deliveredAt?: string
  intent?: string
  agentType?: string
}): AgentSnapshot => ({
  agentId: args.id as ThreadId,
  spawnedBy: PARENT,
  agentType: args.agentType ?? 'general-purpose',
  intent: args.intent ?? args.id,
  status: args.status,
  turns: 1,
  toolCalls: 2,
  lastTool: undefined,
  startedAt: args.startedAt,
  endedAt: args.endedAt,
  deliveredAt: args.deliveredAt,
})

const running = (args: { id: string; startedAt: string }): AgentSnapshot =>
  child({ ...args, status: EAgentStatus.Running })

const finished = (args: { id: string; startedAt: string; endedAt: string }): AgentSnapshot =>
  child({ ...args, status: EAgentStatus.Finished })

describe('agentChoices', () => {
  it('offers a child that has settled alongside one that is still going', () => {
    const choices = agentChoices({
      agents: [
        running({ id: 'live', startedAt: '2026-08-31T10:00:00.000Z' }),
        finished({
          id: 'done',
          startedAt: '2026-08-31T09:00:00.000Z',
          endedAt: '2026-08-31T09:30:00.000Z',
        }),
      ],
    })

    expect(choices.map((one) => String(one.agentId))).toEqual(['live', 'done'])
  })

  it('puts every child still going before every child that has settled', () => {
    const choices = agentChoices({
      agents: [
        finished({
          id: 'newest-done',
          startedAt: '2026-08-31T11:00:00.000Z',
          endedAt: '2026-08-31T11:30:00.000Z',
        }),
        running({ id: 'oldest-live', startedAt: '2026-08-31T08:00:00.000Z' }),
      ],
    })

    expect(choices.map((one) => String(one.agentId))).toEqual(['oldest-live', 'newest-done'])
  })

  it('offers the newest of the running children first', () => {
    const choices = agentChoices({
      agents: [
        running({ id: 'older', startedAt: '2026-08-31T08:00:00.000Z' }),
        running({ id: 'newer', startedAt: '2026-08-31T09:00:00.000Z' }),
      ],
    })

    expect(choices.map((one) => String(one.agentId))).toEqual(['newer', 'older'])
  })

  it('offers the most recently settled child first, by when it ended', () => {
    const choices = agentChoices({
      agents: [
        finished({
          id: 'ended-first',
          startedAt: '2026-08-31T08:00:00.000Z',
          endedAt: '2026-08-31T08:10:00.000Z',
        }),
        finished({
          id: 'ended-last',
          startedAt: '2026-08-31T07:00:00.000Z',
          endedAt: '2026-08-31T09:00:00.000Z',
        }),
      ],
    })

    expect(choices.map((one) => String(one.agentId))).toEqual(['ended-last', 'ended-first'])
  })

  it('states the outcome of a settled child, telling done from failed from stopped', () => {
    const choices = agentChoices({
      agents: [
        child({
          id: 'done',
          status: EAgentStatus.Finished,
          startedAt: '2026-08-31T09:00:00.000Z',
          endedAt: '2026-08-31T09:30:00.000Z',
        }),
        child({
          id: 'failed',
          status: EAgentStatus.Failed,
          startedAt: '2026-08-31T09:00:00.000Z',
          endedAt: '2026-08-31T09:20:00.000Z',
        }),
        child({
          id: 'stopped',
          status: EAgentStatus.Stopped,
          startedAt: '2026-08-31T09:00:00.000Z',
          endedAt: '2026-08-31T09:10:00.000Z',
        }),
      ],
    })

    expect(choices.map((one) => [String(one.agentId), one.state, one.tone])).toEqual([
      ['done', 'done', ESubagentReading.Settled],
      ['failed', 'failed', ESubagentReading.Settled],
      ['stopped', 'stopped', ESubagentReading.Settled],
    ])
  })

  it('reads a child that is still going as unsettled, blocked as much as running', () => {
    const choices = agentChoices({
      agents: [
        child({
          id: 'blocked',
          status: EAgentStatus.Blocked,
          startedAt: '2026-08-31T09:00:00.000Z',
        }),
        child({
          id: 'settled',
          status: EAgentStatus.Finished,
          startedAt: '2026-08-31T10:00:00.000Z',
          endedAt: '2026-08-31T10:30:00.000Z',
        }),
      ],
    })

    expect(choices.map((one) => [String(one.agentId), one.state, one.tone])).toEqual([
      ['blocked', 'blocked', ESubagentReading.Held],
      ['settled', 'done', ESubagentReading.Settled],
    ])
  })

  it('offers a child whose result was already delivered, which is the one the panel lets go of', () => {
    const choices = agentChoices({
      agents: [
        child({
          id: 'delivered',
          status: EAgentStatus.Finished,
          startedAt: '2026-08-31T09:00:00.000Z',
          endedAt: '2026-08-31T09:30:00.000Z',
          deliveredAt: '2026-08-31T09:30:01.000Z',
        }),
      ],
    })

    expect(choices.map((one) => String(one.agentId))).toEqual(['delivered'])
  })

  it('offers nothing for a conversation that has spawned nothing', () => {
    expect(agentChoices({ agents: [] })).toEqual([])
  })

  it('leaves a child whose timestamps cannot be read where the roster put it', () => {
    const choices = agentChoices({
      agents: [
        running({ id: 'unreadable', startedAt: 'not a time' }),
        running({ id: 'readable', startedAt: '2026-08-31T09:00:00.000Z' }),
      ],
    })

    expect(choices.map((one) => String(one.agentId))).toEqual(['readable', 'unreadable'])
  })
})

describe('what a choice is called', () => {
  it('names a child by the intent it was spawned with', () => {
    expect(agentChoiceName({ intent: 'audit  the\nsidebar', agentType: 'explore' })).toBe(
      'audit the sidebar',
    )
  })

  it('falls back to the agent type when the intent says nothing', () => {
    expect(agentChoiceName({ intent: '   ', agentType: 'explore' })).toBe('explore')
  })

  it('says a child is untitled rather than offering a blank row', () => {
    expect(agentChoiceName({ intent: '', agentType: '' })).toBe('an untitled sub-agent')
  })
})

describe('whether a child has settled', () => {
  it('holds every ending, and only an ending', () => {
    const settled = Object.values(EAgentStatus).filter((status) => agentHasSettled({ status }))

    expect(settled.sort()).toEqual(
      [EAgentStatus.Failed, EAgentStatus.Finished, EAgentStatus.Stopped].sort(),
    )
  })
})
