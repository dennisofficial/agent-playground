import { describe, expect, it } from 'bun:test'

import { ERiskDimension, ESeverity } from '../dimension'
import type { RiskSignal } from '../signals'
import { dimensionCitedIn, EJudgment, namingTargetsOf, parseVerdict } from '../verdict'

const signal = (args: {
  dimension?: ERiskDimension | undefined
  subject: string
  severity?: ESeverity | undefined
}): RiskSignal => ({
  dimension: args.dimension ?? ERiskDimension.Contention,
  severity: args.severity ?? ESeverity.Grave,
  id: 'contention:dirty-worktree',
  subject: args.subject,
  detail: 'a detail line',
  ungrantable: true,
})

const STANDING: readonly RiskSignal[] = [signal({ subject: 'worktree:eng-412-sidebar' })]
const TARGETS = namingTargetsOf({ standing: STANDING })

describe('namingTargetsOf', () => {
  it('offers the subject, its value and its leaf as spellings the judge may use', () => {
    expect(
      namingTargetsOf({ standing: [signal({ subject: 'path:/repo/.atlas/worktrees/foo' })] }),
    ).toEqual(['path:/repo/.atlas/worktrees/foo', '/repo/.atlas/worktrees/foo', 'foo'])
  })
})

describe('parseVerdict', () => {
  it('reads a bare proceed', () => {
    expect(parseVerdict({ text: '<verdict>proceed</verdict>', targets: TARGETS })).toEqual({
      judgment: EJudgment.Proceed,
      reason: '',
    })
  })

  it('reads a check that names a surviving target', () => {
    const parsed = parseVerdict({
      text: '<verdict>check</verdict><reason>contention: eng-412-sidebar carries three uncommitted changes that would be lost</reason>',
      targets: TARGETS,
    })

    expect(parsed?.judgment).toBe(EJudgment.Check)
    expect(parsed?.reason).toContain('eng-412-sidebar')
  })

  it('does not read a verdict that only appears inside the model thinking to itself', () => {
    const text = '<thinking><verdict>check</verdict></thinking><verdict>proceed</verdict>'

    expect(parseVerdict({ text, targets: TARGETS })).toEqual({
      judgment: EJudgment.Proceed,
      reason: '',
    })
  })

  it('strips a thinking block the model never closed, verdict and all', () => {
    const text = '<verdict>proceed</verdict><thinking>wait, actually <verdict>check</verdict>'

    expect(parseVerdict({ text, targets: TARGETS })).toEqual({
      judgment: EJudgment.Proceed,
      reason: '',
    })
  })

  it('drops an unterminated thinking block that swallows the only verdict', () => {
    const text =
      '<thinking>let me consider <verdict>check</verdict><reason>eng-412-sidebar</reason>'

    expect(parseVerdict({ text, targets: TARGETS })).toBeUndefined()
  })

  it('takes the first verdict when the model emits two', () => {
    const text =
      '<verdict>proceed</verdict> then <verdict>check</verdict><reason>eng-412-sidebar</reason>'

    expect(parseVerdict({ text, targets: TARGETS })?.judgment).toBe(EJudgment.Proceed)
  })

  it('returns nothing for garbage rather than guessing', () => {
    expect(
      parseVerdict({ text: 'I think you should probably stop', targets: TARGETS }),
    ).toBeUndefined()
    expect(parseVerdict({ text: '', targets: TARGETS })).toBeUndefined()
    expect(parseVerdict({ text: '<verdict>maybe</verdict>', targets: TARGETS })).toBeUndefined()
  })

  it('rejects a check whose reason names nothing concrete', () => {
    const text =
      '<verdict>check</verdict><reason>this feels risky and I would double-check it</reason>'

    expect(parseVerdict({ text, targets: TARGETS })).toBeUndefined()
  })

  it('rejects a check whose reason names a target no surviving signal fired on', () => {
    const text =
      '<verdict>check</verdict><reason>contention: eng-999-unrelated would lose work</reason>'

    expect(parseVerdict({ text, targets: TARGETS })).toBeUndefined()
  })

  it('rejects a check with no reason at all', () => {
    expect(parseVerdict({ text: '<verdict>check</verdict>', targets: TARGETS })).toBeUndefined()
  })

  it('collapses a reason spread over several lines', () => {
    const text = '<verdict>check</verdict><reason>\n  contention:\n  eng-412-sidebar\n</reason>'

    expect(parseVerdict({ text, targets: TARGETS })?.reason).toBe('contention: eng-412-sidebar')
  })
})

describe('dimensionCitedIn', () => {
  it('reads the dimension the reason opens with', () => {
    expect(
      dimensionCitedIn({
        reason: 'contention: eng-412-sidebar carries uncommitted work',
        standing: STANDING,
      }),
    ).toBe(ERiskDimension.Contention)
  })

  it('reads a dimension the judge spelled with spaces', () => {
    const standing = [signal({ dimension: ERiskDimension.SharedHistory, subject: 'ref:main' })]

    expect(
      dimensionCitedIn({ reason: 'shared history on main would be rewritten', standing }),
    ).toBe(ERiskDimension.SharedHistory)
  })

  it('falls back to the dimension of the signal whose target the reason names', () => {
    expect(
      dimensionCitedIn({ reason: 'eng-412-sidebar would lose work', standing: STANDING }),
    ).toBe(ERiskDimension.Contention)
  })

  it('reports nothing when the reason names neither', () => {
    expect(
      dimensionCitedIn({ reason: 'something else entirely', standing: STANDING }),
    ).toBeUndefined()
  })
})
