import { describe, expect, it } from 'bun:test'

import { ERiskDimension, ESeverity } from '../dimension'
import { refusalFor, remedyFor } from '../remedy'
import { riskSignal } from '../probes/kit'
import type { RiskSignal } from '../signals'

const signal = (over: {
  id: string
  dimension?: ERiskDimension
  subject?: string
}): RiskSignal =>
  riskSignal({
    dimension: over.dimension ?? ERiskDimension.Blast,
    severity: ESeverity.Grave,
    id: over.id,
    subject: over.subject ?? 'expansion:$T',
    detail: 'something the reader could not resolve',
  })

describe('what a refused agent is told to do next', () => {
  it('names the concrete step for the shape that fired', () => {
    const remedy = remedyFor({ standing: [signal({ id: 'blast:unresolved-destructive-operand' })] })

    expect(remedy).toContain('literal path')
  })

  it('falls back to the dimension when the exact signal has no step of its own', () => {
    const remedy = remedyFor({
      standing: [signal({ id: 'contention:some-new-signal', dimension: ERiskDimension.Contention })],
    })

    expect(remedy).toContain('your own worktree')
  })

  it('always leaves the agent the route back through the operator', () => {
    for (const id of [
      'blast:unresolved-destructive-operand',
      'blast:undeclared-paths',
      'irreversibility:discard-tree',
      'a-signal-nobody-has-written-yet',
    ]) {
      expect(remedyFor({ standing: [signal({ id })] })).toContain('ask them to confirm')
    }
  })

  it('says only the route back when it has no mechanical step to offer', () => {
    const remedy = remedyFor({ standing: [signal({ id: 'unknown:shape' })] })

    expect(remedy.startsWith('If you still need this')).toBe(true)
  })

  it('does not repeat a step when two signals of one dimension fired', () => {
    const remedy = remedyFor({
      standing: [
        signal({ id: 'contention:a', dimension: ERiskDimension.Contention }),
        signal({ id: 'contention:b', dimension: ERiskDimension.Contention }),
      ],
    })

    expect(remedy.match(/your own worktree/g)).toHaveLength(1)
  })

  it('tells the agent nothing it rephrases will help when the tool itself is silent', () => {
    const remedy = remedyFor({ standing: [signal({ id: 'blast:undeclared-paths' })] })

    expect(remedy).toContain('does not say which paths it touches')
  })
})

describe('the refusal the agent actually reads', () => {
  it('carries what fired and what to do, in that order', () => {
    const refusal = refusalFor({
      reason: 'contention on worktree:eng-412: 7 uncommitted changes would be discarded',
      standing: [signal({ id: 'contention:dirty-worktree', dimension: ERiskDimension.Contention })],
    })

    expect(refusal).toContain('Atlas stopped this call before it ran')
    expect(refusal).toContain('worktree:eng-412')
    expect(refusal.indexOf('worktree:eng-412')).toBeLessThan(refusal.indexOf('ask them to confirm'))
  })
})
