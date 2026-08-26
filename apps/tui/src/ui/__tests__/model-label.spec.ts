import { describe, expect, it } from 'bun:test'

import { modelLabel } from '../model-label'

describe('modelLabel', () => {
  it('drops a trailing release stamp', () => {
    expect(modelLabel('claude-haiku-4-5-20251001')).toBe('claude-haiku-4-5')
  })

  it('leaves an undated id alone', () => {
    expect(modelLabel('claude-opus-5')).toBe('claude-opus-5')
  })

  it('leaves a version that only looks like a date alone', () => {
    expect(modelLabel('gpt-5-2025')).toBe('gpt-5-2025')
  })

  it('strips only the trailing stamp', () => {
    expect(modelLabel('anthropic/claude-20240620-sonnet')).toBe('anthropic/claude-20240620-sonnet')
  })
})
