import { EAgentStatus, toThreadId } from '@dltech/atlas-core'
import type { AgentSnapshot } from '@dltech/atlas-harness'
import { describe, expect, it } from 'bun:test'

import { ESpendReading, SPEND_UNAVAILABLE, type AgentSpend, type SpendTotals } from '../agent-spend'
import { deriveSidebar, withCrew } from '../sidebar-model'
import {
  subagentContextLabel,
  subagentElapsedMs,
  subagentFigures,
  subagentRows,
  subagentSpendLabel,
  subagentStateLabel,
  type SubagentReadout,
} from '../subagent-row'
import { IDLE_TURN } from '../../ui/components/transcript'
import { log } from './fixture'

const PARENT = toThreadId('thr_parent')

const CHILD = toThreadId('thr_child')

const STARTED = '2026-01-01T00:00:00.000Z'

const NOW = Date.parse('2026-01-01T00:01:04.000Z')

const snapshot = (over: Partial<AgentSnapshot> = {}): AgentSnapshot => ({
  agentId: CHILD,
  spawnedBy: PARENT,
  agentType: 'explore',
  intent: 'vault audit',
  status: EAgentStatus.Running,
  turns: 0,
  toolCalls: 0,
  lastTool: undefined,
  startedAt: STARTED,
  endedAt: undefined,
  ...over,
})

const rows = (over: Partial<AgentSnapshot> = {}) =>
  subagentRows({ snapshots: [snapshot(over)], now: NOW })

const counted = (over: { totals?: SpendTotals } = {}): AgentSpend => ({
  reading: ESpendReading.Counted,
  totals: {
    turns: 2,
    steps: 5,
    inputTokens: 48_200,
    outputTokens: 3_100,
    cacheReadTokens: 41_000,
    cacheWriteTokens: 2_000,
  },
  ...over,
})

const readout = (over: Partial<SubagentReadout> = {}): SubagentReadout => ({
  status: EAgentStatus.Running,
  calls: 0,
  lastTool: null,
  startedAt: STARTED,
  endedAt: null,
  ...over,
})

const labelOf = (over: Partial<SubagentReadout> = {}): string =>
  subagentStateLabel({ subagent: readout(over), now: NOW })

describe('a child row is derived from the child', () => {
  it('counts the work the supervisor saw the child do', () => {
    const [built] = rows({ toolCalls: 7 })

    expect(built?.calls).toBe(7)
  })

  it('takes no turn count from the conversation it is listed beside', () => {
    const parent = deriveSidebar({
      events: log([
        { type: 'user-said', text: 'audit the vault' },
        { type: 'user-said', text: 'and the key file' },
      ]),
      turn: IDLE_TURN,
      name: 'the parent conversation',
    })

    const merged = withCrew({ model: parent, subagents: rows() })

    expect(merged.turnCount).toBe(2)
    expect(merged.subagents?.[0]?.calls).toBe(0)
  })

  it('names an untitled child by its type rather than borrowing a title', () => {
    expect(rows({ intent: '   ' })[0]?.name).toBe('explore')
  })

  it('folds an intent written across lines onto one row', () => {
    expect(rows({ intent: 'vault\n  audit' })[0]?.name).toBe('vault audit')
  })

  it('carries the reading the row renders rather than making the view assemble it', () => {
    expect(rows({ lastTool: 'grep', toolCalls: 4 })[0]?.state).toBe('grep · 1m 4s')
  })
})

describe('what the narrow value column says about a child', () => {
  it('reads a working child as the tool it is on and how long it has been going', () => {
    expect(labelOf({ lastTool: 'bash' })).toBe('bash · 1m 4s')
  })

  it('still gives a working child that has called nothing yet its elapsed time', () => {
    expect(labelOf()).toBe('1m 4s')
  })

  it('says how long a blocked child has been stuck, which is the whole question', () => {
    expect(labelOf({ status: EAgentStatus.Blocked, lastTool: 'bash', calls: 9 })).toBe(
      'blocked · 1m 4s',
    )
  })

  it('reads a settled child as its outcome and the work it got through', () => {
    const ended = { endedAt: '2026-01-01T00:00:30.000Z', calls: 7 }

    expect(labelOf({ ...ended, status: EAgentStatus.Finished })).toBe('done · 7 calls')
    expect(labelOf({ ...ended, status: EAgentStatus.Failed })).toBe('failed · 7 calls')
    expect(labelOf({ ...ended, status: EAgentStatus.Stopped })).toBe('stopped · 7 calls')
  })

  it('counts one call as a call', () => {
    expect(labelOf({ status: EAgentStatus.Finished, calls: 1 })).toBe('done · 1 call')
  })

  it('falls back to the bare state word when a child did nothing worth counting', () => {
    expect(labelOf({ status: EAgentStatus.Finished, calls: 0 })).toBe('done')
  })

  it('stops the clock of a child that ended rather than running it to now', () => {
    const stopped = readout({
      status: EAgentStatus.Finished,
      endedAt: '2026-01-01T00:00:30.000Z',
    })

    expect(subagentElapsedMs({ subagent: stopped, now: NOW })).toBe(30_000)
  })

  it('never reads earlier than the child started, so elapsed cannot go negative', () => {
    expect(subagentElapsedMs({ subagent: readout(), now: Date.parse(STARTED) - 5_000 })).toBe(0)
  })

  it('says nothing about time it cannot read', () => {
    expect(subagentElapsedMs({ subagent: readout({ startedAt: 'not a stamp' }), now: NOW })).toBe(
      null,
    )
  })
})

describe('what a child cost', () => {
  it('reads both directions, because input is where a child spends', () => {
    expect(subagentSpendLabel(counted())).toBe('↑ 48.2k  ↓ 3.1k')
  })

  it('says the reading is missing rather than claiming the child was free', () => {
    expect(subagentSpendLabel(SPEND_UNAVAILABLE)).toBe('tokens unavailable')
  })

  it('says nothing at all before the ledger has been asked', () => {
    expect(subagentSpendLabel(null)).toBe(null)
  })

  it('spends no row height on a child that has not spent anything yet', () => {
    const nothing = counted({
      totals: {
        turns: 0,
        steps: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      },
    })

    expect(subagentSpendLabel(nothing)).toBe(null)
  })

  it('carries the reading onto the row the sidebar renders', () => {
    const built = subagentRows({
      snapshots: [snapshot()],
      now: NOW,
      spend: new Map([[CHILD, counted()]]),
    })

    expect(subagentSpendLabel(built[0]?.spend ?? null)).toBe('↑ 48.2k  ↓ 3.1k')
  })

  it('leaves a child the map has no entry for unread rather than counted at zero', () => {
    expect(subagentRows({ snapshots: [snapshot()], now: NOW, spend: new Map() })[0]?.spend).toBe(
      null,
    )
  })
})

describe("how full the child's own window is", () => {
  it('reads the child against the window the child runs, never the window the parent runs', () => {
    expect(subagentContextLabel({ tokens: 68_000, window: 200_000 })).toBe('ctx 34%')
  })

  it('says nothing when the window is unknown rather than reading the child as empty', () => {
    expect(subagentContextLabel({ tokens: 68_000, window: 0 })).toBe(null)
  })

  it('carries the reading the supervisor took onto the row, from the snapshot itself', () => {
    const built = rows({ context: { tokens: 68_000, window: 200_000 } })

    expect(subagentContextLabel(built[0]?.context)).toBe('ctx 34%')
  })

  it('leaves a child nothing has measured unmeasured rather than measured at zero', () => {
    expect(rows()[0]?.context).toBe(undefined)
  })

  it('keeps a child measured as barely started apart from one nothing has measured', () => {
    expect(subagentContextLabel({ tokens: 400, window: 200_000 })).toBe('ctx 0%')
    expect(subagentContextLabel(undefined)).toBe(null)
  })
})

describe('the second line a child row hangs off its right edge', () => {
  it('writes what the child cost first and how full it has got to the right of it', () => {
    expect(
      subagentFigures({ spend: counted(), context: { tokens: 68_000, window: 200_000 } }),
    ).toBe('↑ 48.2k  ↓ 3.1k  ctx 34%')
  })

  it('writes the window reading alone when the ledger has not answered yet', () => {
    expect(subagentFigures({ spend: null, context: { tokens: 68_000, window: 200_000 } })).toBe(
      'ctx 34%',
    )
  })

  it('writes the spend alone when nothing has measured the child yet', () => {
    expect(subagentFigures({ spend: counted(), context: undefined })).toBe('↑ 48.2k  ↓ 3.1k')
  })

  it('spends no row height on a child neither reading has reached', () => {
    expect(subagentFigures({ spend: null, context: undefined })).toBe(null)
  })

  it('still says the spend is missing when the window reading arrived without it', () => {
    expect(
      subagentFigures({ spend: SPEND_UNAVAILABLE, context: { tokens: 68_000, window: 200_000 } }),
    ).toBe('tokens unavailable  ctx 34%')
  })
})

describe('merging the crew into a sidebar', () => {
  it('leaves a sidebar untouched when there is no crew to add', () => {
    const parent = deriveSidebar({ events: [], turn: IDLE_TURN, name: null })

    expect(withCrew({ model: parent, subagents: [] })).toBe(parent)
  })

  it('carries no context reading of the child onto the model the meter reads', () => {
    const parent = deriveSidebar({ events: [], turn: IDLE_TURN, name: null })
    const merged = withCrew({ model: parent, subagents: rows({ turns: 9 }) })

    expect(merged.spend).toBe(parent.spend)
  })

  /**
   * The same guard, now that a child carries a token count of its own: a child's window is not the
   * parent's, and summing them would make the parent's remaining context read as a lie.
   */
  it('keeps a child with real spend off the meter the parent reads', () => {
    const parent = deriveSidebar({ events: [], turn: IDLE_TURN, name: null })
    const spent = subagentRows({
      snapshots: [snapshot()],
      now: NOW,
      spend: new Map([[CHILD, counted()]]),
    })
    const merged = withCrew({ model: parent, subagents: spent })

    expect(subagentSpendLabel(merged.subagents?.[0]?.spend ?? null)).toBe('↑ 48.2k  ↓ 3.1k')
    expect(merged.spend).toBe(parent.spend)
  })

  /**
   * And again for the child's own window, the reading most tempting to add up: a child may run a
   * different model, so its window is not a share of the parent's and cannot be pooled with it.
   */
  it('keeps a measured child off the meter the parent reads', () => {
    const parent = deriveSidebar({ events: [], turn: IDLE_TURN, name: null })
    const measured = subagentRows({
      snapshots: [snapshot({ context: { tokens: 68_000, window: 200_000 } })],
      now: NOW,
      spend: new Map([[CHILD, counted()]]),
    })
    const merged = withCrew({ model: parent, subagents: measured })
    const row = merged.subagents?.[0]

    expect(row === undefined ? null : subagentFigures(row)).toBe('↑ 48.2k  ↓ 3.1k  ctx 34%')
    expect(merged.spend).toBe(parent.spend)
    expect(Object.keys(merged).filter((field) => !(field in parent))).toEqual(['subagents'])
  })
})
