import { EAgentStatus, toThreadId } from '@dltech/atlas-core'
import type { RecoveredAgents, UnloggedChild } from '@dltech/atlas-harness'
import { describe, expect, it } from 'bun:test'

import { hasLostChildren, lostChildCount, lostChildName, lostChildRows } from '../lost-children-model'

const AT = '2026-01-01T09:15:00.000Z'

const unlogged = (over: Partial<UnloggedChild> = {}): UnloggedChild => ({
  agentId: toThreadId('thr_orphan'),
  agentType: 'explore',
  title: 'explore (vault audit)',
  startedAt: AT,
  ...over,
})

const recovered = (over: Partial<RecoveredAgents> = {}): RecoveredAgents => ({
  settled: [],
  unlogged: [],
  ...over,
})

describe('what a lost child is called', () => {
  it('uses the title the child thread was opened under', () => {
    expect(lostChildName(unlogged())).toBe('explore (vault audit)')
  })

  it('falls back to the type when the thread was never titled', () => {
    expect(lostChildName(unlogged({ title: undefined }))).toBe('explore')
    expect(lostChildName(unlogged({ title: '   ' }))).toBe('explore')
  })

  it('still names it something a reader can hold when nothing is known', () => {
    expect(lostChildName(unlogged({ title: undefined, agentType: undefined }))).toBe(
      'an untitled sub-agent',
    )
  })

  it('folds a title written across lines onto one', () => {
    expect(lostChildName(unlogged({ title: 'explore\n  (vault audit)' }))).toBe(
      'explore (vault audit)',
    )
  })
})

describe('which recovered children are worth reporting', () => {
  it('reports nothing at all on a clean open', () => {
    expect(hasLostChildren(recovered())).toBe(false)
    expect(hasLostChildren(null)).toBe(false)
    expect(lostChildRows(null)).toEqual([])
  })

  /**
   * The settled ones already have an `agent-ended` in the parent's log, written before the
   * transcript was read, so they are on screen with their counts. Repeating them here would bury
   * the unlogged, which nothing else in the app mentions.
   */
  it('leaves out a child that recovery was able to write an ending for', () => {
    const settled = recovered({
      settled: [
        {
          agentId: toThreadId('thr_settled'),
          spawnedBy: toThreadId('thr_parent'),
          agentType: 'explore',
          intent: 'vault audit',
          status: EAgentStatus.Stopped,
          turns: 2,
          toolCalls: 7,
          lastTool: undefined,
          startedAt: AT,
          endedAt: AT,
        },
      ],
    })

    expect(hasLostChildren(settled)).toBe(false)
  })

  it('reports a child the parent has no record of, which nothing else will', () => {
    const rows = lostChildRows(recovered({ unlogged: [unlogged()] }))

    expect(rows).toHaveLength(1)
    expect(rows[0]?.name).toBe('explore (vault audit)')
    expect(rows[0]?.startedAt).toBe(AT)
  })

  it('counts them for the badge, singular and plural', () => {
    expect(lostChildCount(lostChildRows(recovered({ unlogged: [unlogged()] })))).toBe('1 sub-agent')
    expect(
      lostChildCount(
        lostChildRows(
          recovered({
            unlogged: [unlogged(), unlogged({ agentId: toThreadId('thr_other') })],
          }),
        ),
      ),
    ).toBe('2 sub-agents')
  })
})
