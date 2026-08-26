import { parseColor, TextAttributes, type TextChunk } from '@opentui/core'
import { describe, expect, it } from 'bun:test'

import { chunksFor, dimChunks, emphasiseChunks, emphasisBg } from '../chunk-styling'

const WORD_BG = parseColor('#335030')

const chunk = (text: string, fg?: string): TextChunk =>
  fg === undefined ? { __isChunk: true, text } : { __isChunk: true, text, fg: parseColor(fg) }

const textOf = (chunks: readonly TextChunk[]): string =>
  chunks.map((one) => one.text).join('')

describe('chunksFor', () => {
  it('keeps the highlighting when it still spells the line', () => {
    const chunks = [chunk('const'), chunk(' a')]
    expect(chunksFor({ text: 'const a', chunks })).toBe(chunks)
  })

  it('falls back to plain text when the highlighting belongs to another line', () => {
    const fallback = chunksFor({ text: 'const b', chunks: [chunk('const a')] })
    expect(textOf(fallback)).toBe('const b')
    expect(fallback).toHaveLength(1)
  })

  it('falls back when there is no highlighting at all', () => {
    expect(textOf(chunksFor({ text: 'plain', chunks: null }))).toBe('plain')
  })
})

describe('dimChunks', () => {
  it('adds dim without dropping the attributes the grammar set', () => {
    const dimmed = dimChunks([{ __isChunk: true, text: 'x', attributes: TextAttributes.BOLD }])
    expect(dimmed[0]?.attributes).toBe(TextAttributes.BOLD | TextAttributes.DIM)
  })
})

describe('emphasiseChunks', () => {
  it('splits one chunk into before, emphasised and after', () => {
    const out = emphasiseChunks({
      chunks: [chunk('abcdefgh', '#f00')],
      span: { start: 2, end: 5 },
      bg: WORD_BG,
    })
    expect(out.map((one) => one.text)).toEqual(['ab', 'cde', 'fgh'])
    expect(out[1]?.bg?.equals(WORD_BG)).toBe(true)
    expect(out[1]?.fg?.equals(parseColor('#f00'))).toBe(true)
    expect(out[0]?.bg).toBeUndefined()
  })

  it('carries the span across a chunk boundary without losing a character', () => {
    const out = emphasiseChunks({
      chunks: [chunk('abc'), chunk('def'), chunk('ghi')],
      span: { start: 2, end: 7 },
      bg: WORD_BG,
    })
    expect(textOf(out)).toBe('abcdefghi')
    expect(out.filter((one) => one.bg !== undefined).map((one) => one.text)).toEqual([
      'c',
      'def',
      'g',
    ])
  })

  it('leaves a line alone when the span misses it', () => {
    const out = emphasiseChunks({
      chunks: [chunk('abc')],
      span: { start: 5, end: 9 },
      bg: WORD_BG,
    })
    expect(out.every((one) => one.bg === undefined)).toBe(true)
  })
})

describe('emphasisBg', () => {
  it('hands back the same parsed colour rather than reparsing per row', () => {
    expect(emphasisBg('#335030')).toBe(emphasisBg('#335030'))
  })
})
