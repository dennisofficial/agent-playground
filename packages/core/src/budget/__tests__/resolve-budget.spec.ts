import { describe, expect, it } from 'bun:test'

import { assemble } from '../../assembly/assemble'
import { compactedHistory } from '../../assembly/rules/compacted-history'
import { messagesFromEvents } from '../../assembly/rules/messages-from-events'
import { estimateTokens } from '../../assembly/tokens'
import { eventsFrom, replied, said } from '../../compaction/__tests__/fixture'
import type { EventDraft } from '../../events/body'
import type { Event } from '../../events/envelope'
import { toBranchId } from '../../events/ids'
import { EBudgetVerdict, resolveBudget } from '../resolve-budget'

const THOUSAND_TOKENS = 'x'.repeat(4_000)

const turns = (count: number): readonly EventDraft[] =>
  Array.from({ length: count }, () => [said(THOUSAND_TOKENS), replied(THOUSAND_TOKENS)]).flat()

const assembleWith = (events: readonly Event[]) =>
  assemble({
    rules: [messagesFromEvents(), compactedHistory()],
    ctx: {
      events,
      branchId: toBranchId('branch-1'),
      step: 0,
      provider: { id: 'anthropic', modelId: 'claude-opus-5' },
      countTokens: estimateTokens,
    },
  }).assembled

const resolve = (args: { events: readonly Event[]; limit: number; ladder?: readonly number[] }) =>
  resolveBudget({
    events: args.events,
    limit: args.limit,
    assembleWith,
    countTokens: estimateTokens,
    ...(args.ladder === undefined ? {} : { ladder: args.ladder }),
  })

describe('resolveBudget', () => {
  it('leaves a prompt that already fits alone', () => {
    const decision = resolve({ events: eventsFrom(turns(2)), limit: 100_000 })

    expect(decision.verdict).toBe(EBudgetVerdict.Fits)
  })

  it('recommends a compaction when the prompt is over the limit', () => {
    const decision = resolve({ events: eventsFrom(turns(60)), limit: 20_000 })

    expect(decision.verdict).toBe(EBudgetVerdict.Compact)
  })

  it('measures the recommendation by re-running assembly, not by arithmetic', () => {
    const decision = resolve({ events: eventsFrom(turns(60)), limit: 20_000 })

    if (decision.verdict !== EBudgetVerdict.Compact) throw new Error('expected a compaction')
    expect(decision.projected).toBeLessThanOrEqual(20_000)
    expect(decision.projected).toBeLessThan(decision.tokens)
  })

  it('descends the ladder only as far as it must, keeping the shallowest compaction that fits', () => {
    const events = eventsFrom(turns(60))

    const shallow = resolve({ events, limit: 50_000 })
    const deep = resolve({ events, limit: 10_000 })

    if (shallow.verdict !== EBudgetVerdict.Compact) throw new Error('expected a compaction')
    if (deep.verdict !== EBudgetVerdict.Compact) throw new Error('expected a compaction')
    expect(deep.plan.throughSeq).toBeGreaterThan(shallow.plan.throughSeq)
  })

  it('reports exhaustion rather than a plan when no rung on the ladder fits', () => {
    const decision = resolve({ events: eventsFrom(turns(60)), limit: 1 })

    expect(decision.verdict).toBe(EBudgetVerdict.Exhausted)
  })

  it('reports exhaustion when there is nothing left to compact', () => {
    const decision = resolve({ events: eventsFrom(turns(1)), limit: 1 })

    expect(decision.verdict).toBe(EBudgetVerdict.Exhausted)
  })
})
