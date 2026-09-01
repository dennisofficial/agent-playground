import { describe, expect, it } from 'bun:test'

import { boundedIndex, MAX_INDEX_BYTES, MAX_INDEX_LINES } from '../index-file'

describe('boundedIndex', () => {
  it('passes a small index through untouched but trimmed', () => {
    const bounded = boundedIndex({ content: '\n- [One](one.md) — a hook\n' })
    expect(bounded.text).toBe('- [One](one.md) — a hook')
    expect(bounded.lineCapped).toBe(false)
    expect(bounded.byteCapped).toBe(false)
  })

  it('cuts at the line cap and says so', () => {
    const content = Array.from({ length: MAX_INDEX_LINES + 40 }, (_, at) => `- line ${at}`).join(
      '\n',
    )
    const bounded = boundedIndex({ content })

    expect(bounded.lineCapped).toBe(true)
    expect(bounded.lines).toBe(MAX_INDEX_LINES + 40)
    expect(bounded.text).toContain('Only part of this index was loaded')
    expect(bounded.text).toContain(`- line ${MAX_INDEX_LINES - 1}`)
    expect(bounded.text).not.toContain(`- line ${MAX_INDEX_LINES}\n`)
  })

  it('cuts long lines at the byte cap even when the line count is fine', () => {
    const content = Array.from({ length: 10 }, () => 'x'.repeat(4_000)).join('\n')
    const bounded = boundedIndex({ content })

    expect(bounded.byteCapped).toBe(true)
    expect(bounded.lineCapped).toBe(false)
    expect(bounded.text).toContain('entries are too long')
  })

  it('never cuts mid-line when the byte cap fires', () => {
    const line = `${'y'.repeat(300)}`
    const content = Array.from({ length: 150 }, () => line).join('\n')
    const bounded = boundedIndex({ content })

    expect(bounded.byteCapped).toBe(true)
    const body = bounded.text.split('\n\n>')[0] ?? ''
    for (const kept of body.split('\n')) expect(kept).toBe(line)
  })

  it('reports both caps when both fire', () => {
    const content = Array.from({ length: 400 }, () => 'z'.repeat(200)).join('\n')
    const bounded = boundedIndex({ content })

    expect(bounded.lineCapped).toBe(true)
    expect(bounded.byteCapped).toBe(true)
    expect(bounded.bytes).toBeGreaterThan(MAX_INDEX_BYTES)
    expect(bounded.text).toContain('lines and')
  })
})
