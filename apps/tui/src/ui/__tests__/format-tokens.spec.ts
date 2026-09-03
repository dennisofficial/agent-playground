import { describe, expect, test } from 'bun:test'

import { formatTokens } from '../theme'

describe('formatTokens', () => {
  test('shows small counts raw', () => {
    expect(formatTokens(0)).toBe('0')
    expect(formatTokens(999)).toBe('999')
  })

  test('shows thousands with one decimal', () => {
    expect(formatTokens(1000)).toBe('1.0k')
    expect(formatTokens(179_700)).toBe('179.7k')
    expect(formatTokens(999_999)).toBe('1000.0k')
  })

  test('shows millions with two decimals', () => {
    expect(formatTokens(1_000_000)).toBe('1.00m')
    expect(formatTokens(1_234_000)).toBe('1.23m')
    expect(formatTokens(45_840_200)).toBe('45.84m')
  })

  test('shows billions with two decimals', () => {
    expect(formatTokens(1_000_000_000)).toBe('1.00b')
    expect(formatTokens(2_500_000_000)).toBe('2.50b')
  })
})
