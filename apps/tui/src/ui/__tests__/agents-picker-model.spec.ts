import { describe, expect, it } from 'bun:test'

import { ESubagentReading } from '../../store/subagent-row'
import {
  agentsWindow,
  moveAgentSelection,
  openedAgents,
  selectedAgent,
  type AgentPickerRow,
} from '../agents-picker-model'

const row = (args: { id: string; state?: string; tone?: ESubagentReading }): AgentPickerRow => ({
  agentId: args.id,
  name: args.id,
  state: args.state ?? 'running',
  tone: args.tone ?? ESubagentReading.Live,
})

const rowsOf = (count: number): readonly AgentPickerRow[] =>
  Array.from({ length: count }, (_, at) => row({ id: `child-${at}` }))

describe('opening the sub-agent picker', () => {
  it('starts on the first row, which is the one most worth reading', () => {
    const state = openedAgents({
      rows: [row({ id: 'live' }), row({ id: 'done', tone: ESubagentReading.Settled })],
    })

    expect(state.index).toBe(0)
    expect(selectedAgent(state)?.agentId).toBe('live')
  })

  it('keeps the rows in the order it was handed them', () => {
    const state = openedAgents({
      rows: [
        row({ id: 'live' }),
        row({ id: 'done', state: 'done', tone: ESubagentReading.Settled }),
      ],
    })

    expect(state.rows.map((one) => one.agentId)).toEqual(['live', 'done'])
  })
})

describe('moving through the sub-agent picker', () => {
  it('walks down to a settled child and back up again', () => {
    const opened = openedAgents({
      rows: [
        row({ id: 'live' }),
        row({ id: 'done', state: 'done', tone: ESubagentReading.Settled }),
      ],
    })

    const down = moveAgentSelection({ state: opened, delta: 1 })
    expect(selectedAgent(down)?.agentId).toBe('done')

    expect(selectedAgent(moveAgentSelection({ state: down, delta: -1 }))?.agentId).toBe('live')
  })

  it('stops at the ends rather than wrapping past them', () => {
    const opened = openedAgents({ rows: rowsOf(3) })

    expect(moveAgentSelection({ state: opened, delta: -1 }).index).toBe(0)
    expect(moveAgentSelection({ state: opened, delta: 9 }).index).toBe(2)
  })

  it('has nothing to move through when the conversation spawned nothing', () => {
    const opened = openedAgents({ rows: [] })

    expect(moveAgentSelection({ state: opened, delta: 1 }).index).toBe(0)
    expect(selectedAgent(opened)).toBeUndefined()
  })
})

describe('the window the picker draws', () => {
  it('shows every child when they all fit', () => {
    const window = agentsWindow({ state: openedAgents({ rows: rowsOf(3) }), rows: 8 })

    expect(window).toEqual({ start: 0, visible: rowsOf(3), below: 0 })
  })

  it('counts the children below the fold rather than dropping them silently', () => {
    const window = agentsWindow({ state: openedAgents({ rows: rowsOf(12) }), rows: 8 })

    expect(window.start).toBe(0)
    expect(window.visible).toHaveLength(8)
    expect(window.below).toBe(4)
  })

  it('scrolls to keep the selected child on screen', () => {
    const opened = moveAgentSelection({ state: openedAgents({ rows: rowsOf(12) }), delta: 11 })

    const window = agentsWindow({ state: opened, rows: 8 })

    expect(window.start).toBe(4)
    expect(window.visible.at(-1)?.agentId).toBe('child-11')
    expect(window.below).toBe(0)
  })
})
