import { describe, expect, it } from 'bun:test'

import { agentLabel } from '../label'

describe('naming a delegate for the parent that spawned it', () => {
  it('pairs the agent type with the intent it was given', () => {
    expect(agentLabel({ agentType: 'explore', intent: 'audit the settings registry' })).toBe(
      'explore "audit the settings registry"',
    )
  })

  it('falls back to the type alone when there is no intent to quote', () => {
    expect(agentLabel({ agentType: 'explore', intent: '   ' })).toBe('explore')
  })

  it('collapses a multi-line intent onto one line', () => {
    expect(agentLabel({ agentType: 'review', intent: 'read this\n\nthen that' })).toBe(
      'review "read this then that"',
    )
  })

  it('truncates an intent long enough to crowd out the report it heads', () => {
    const label = agentLabel({ agentType: 'review', intent: 'x'.repeat(400) })

    expect(label.length).toBeLessThan(140)
    expect(label).toContain('…')
  })
})
