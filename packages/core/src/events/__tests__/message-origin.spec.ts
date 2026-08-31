import { describe, expect, it } from 'bun:test'

import { EMessageOrigin, saidBy, type EventDraft } from '../body'

const said = (over: Partial<Extract<EventDraft, { type: 'user-said' }>> = {}) => ({
  type: 'user-said' as const,
  text: 'carry on',
  ...over,
})

describe('whose voice a child is reading', () => {
  it('reads a row that names nobody as the operator, which is what every row was', () => {
    expect(saidBy(said())).toBe(EMessageOrigin.Operator)
  })

  it('reads a row the parent agent wrote as the parent agent', () => {
    expect(saidBy(said({ via: EMessageOrigin.ParentAgent }))).toBe(EMessageOrigin.ParentAgent)
  })

  it('reads an explicit operator row as the operator', () => {
    expect(saidBy(said({ via: EMessageOrigin.Operator }))).toBe(EMessageOrigin.Operator)
  })
})
