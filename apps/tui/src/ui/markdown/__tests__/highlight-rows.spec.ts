import { parseColor, type TextChunk } from '@opentui/core'
import { describe, expect, it } from 'bun:test'

import { chunksByLine, fitDiffChunks, highlightRows, wrapDiffChunks } from '../highlight-rows'
import { grammarsReady } from './harness'

await grammarsReady()

function chunk(text: string, fg?: string): TextChunk {
  if (fg === undefined) return { __isChunk: true, text }
  return { __isChunk: true, text, fg: parseColor(fg) }
}

function textOf(rows: readonly (readonly TextChunk[])[]): string[] {
  return rows.map((row) => row.map((c) => c.text).join(''))
}

describe('chunksByLine', () => {
  it('cuts a run that spans lines without losing or duplicating a character', () => {
    const rows = chunksByLine({ chunks: [chunk('const a = 1;\nconst b = 2;')], lines: 2 })
    expect(textOf(rows)).toEqual(['const a = 1;', 'const b = 2;'])
  })

  it('keeps several chunks on one line, in order, with their styles', () => {
    const rows = chunksByLine({
      chunks: [chunk('const', '#f00'), chunk(' a = '), chunk('1', '#0f0'), chunk(';\nnext')],
      lines: 2,
    })
    expect(textOf(rows)).toEqual(['const a = 1;', 'next'])
    expect(rows[0]?.length).toBe(4)
    expect(rows[0]?.[0]?.fg?.equals(parseColor('#f00'))).toBe(true)
    expect(rows[0]?.[2]?.fg?.equals(parseColor('#0f0'))).toBe(true)
  })

  it('gives an empty line an empty row rather than swallowing it', () => {
    const rows = chunksByLine({ chunks: [chunk('a\n\nb')], lines: 3 })
    expect(textOf(rows)).toEqual(['a', '', 'b'])
  })

  it('always returns exactly one row per line, even if the chunks run short or long', () => {
    expect(chunksByLine({ chunks: [chunk('a')], lines: 3 })).toHaveLength(3)
    expect(chunksByLine({ chunks: [chunk('a\nb\nc\nd')], lines: 2 })).toHaveLength(2)
  })
})

describe('fitDiffChunks', () => {
  it('leaves a row that fits completely alone', () => {
    const chunks = [chunk('const'), chunk(' a')]
    expect(fitDiffChunks({ chunks, columns: 20 })).toBe(chunks)
  })

  it('clips across chunk boundaries and lands exactly on the band', () => {
    const fitted = fitDiffChunks({
      chunks: [chunk('const'), chunk(' a = '), chunk('1234567890')],
      columns: 10,
    })
    const text = fitted.map((c) => c.text).join('')
    expect(text).toBe('const a =…')
    expect(text.length).toBe(10)
  })

  it('gives the ellipsis the colour of the chunk it cut, not one of its own', () => {
    const fitted = fitDiffChunks({ chunks: [chunk('abcdefgh', '#f00')], columns: 4 })
    expect(fitted.at(-1)?.text).toBe('…')
    expect(fitted.at(-1)?.fg?.equals(parseColor('#f00'))).toBe(true)
  })
})

describe('wrapDiffChunks', () => {
  it('leaves a row that fits completely alone', () => {
    const chunks = [chunk('bun'), chunk(' test')]
    expect(wrapDiffChunks({ chunks, columns: 20 })).toEqual([chunks])
  })

  it('wraps at word boundaries, dropping the space it broke on', () => {
    const rows = wrapDiffChunks({ chunks: [chunk('foo bar baz')], columns: 4 })
    expect(textOf(rows)).toEqual(['foo', 'bar', 'baz'])
  })

  it('hard-breaks a word longer than the row, the way a terminal wraps a path', () => {
    const rows = wrapDiffChunks({ chunks: [chunk('cd /aaaaaaaaaa')], columns: 6 })
    expect(textOf(rows)).toEqual(['cd', '/aaaaa', 'aaaaa'])
  })

  it('splits styled chunks at the break without losing their colours', () => {
    const rows = wrapDiffChunks({
      chunks: [chunk('bun ', '#0f0'), chunk('run build', '#f00')],
      columns: 5,
    })
    expect(textOf(rows)).toEqual(['bun', 'run', 'build'])
    expect(rows[0]?.[0]?.fg?.equals(parseColor('#0f0'))).toBe(true)
    expect(rows[1]?.[0]?.fg?.equals(parseColor('#f00'))).toBe(true)
    expect(rows[2]?.[0]?.fg?.equals(parseColor('#f00'))).toBe(true)
  })

  it('does not start a row on the space it broke before', () => {
    const rows = wrapDiffChunks({ chunks: [chunk('foo bar')], columns: 3 })
    expect(textOf(rows)).toEqual(['foo', 'bar'])
  })

  it('does not leave an empty row behind a trailing space at the break', () => {
    const rows = wrapDiffChunks({ chunks: [chunk('foo ')], columns: 3 })
    expect(textOf(rows)).toEqual(['foo'])
  })
})

describe('highlightRows', () => {
  it('highlights a mid-file fragment, which is all a hunk ever is', async () => {
    // Unbalanced on purpose: this starts inside a function body and never closes it. Tree-sitter's
    // error recovery is what makes highlighting a hunk viable at all.
    const rows = await highlightRows({
      lines: ['  const parsed = JSON.parse(raw);', '  if (!parsed.name) throw new Error("no");'],
      filetype: 'typescript',
    })
    expect(rows).not.toBeNull()
    expect(rows).toHaveLength(2)
    expect(textOf(rows ?? [])).toEqual([
      '  const parsed = JSON.parse(raw);',
      '  if (!parsed.name) throw new Error("no");',
    ])
    const colours = new Set((rows ?? []).flat().map((c) => String(c.fg)))
    expect(colours.size).toBeGreaterThan(2)
  })

  it('returns null for a filetype with no grammar, so the caller keeps its plain text', async () => {
    expect(await highlightRows({ lines: ['fn main() {}'], filetype: 'nonesuch' })).toBeNull()
  })

  it('reproduces the row text byte for byte, so the code stays aligned with its gutter', async () => {
    const lines = ['const s = "a\\nb";', '/** doc */', '']
    const rows = await highlightRows({ lines, filetype: 'typescript' })
    expect(textOf(rows ?? [])).toEqual(lines)
  })

  it('highlights a vendored grammar, not just the ones OpenTUI ships', async () => {
    const rows = await highlightRows({
      lines: ['SELECT id, COUNT(m.id) AS n', 'FROM sessions s'],
      filetype: 'sql',
    })
    expect(rows).not.toBeNull()
    expect(new Set((rows ?? []).flat().map((c) => String(c.fg))).size).toBeGreaterThan(2)
  })
})
