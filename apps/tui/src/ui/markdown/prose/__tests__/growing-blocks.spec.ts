import { describe, expect, it } from 'bun:test'

import { CORPUS } from '../../__tests__/streamed-corpus'
import { EProseBlock, sourcedProseBlocks } from '../blocks'
import { growingProseBlocks, proseBlocksFor } from '../growing-blocks'

const SPANNING = [
  'Lead paragraph.',
  '',
  '- one',
  '',
  '- two, loose',
  '',
  '  ```ts',
  '  const inside = 1',
  '',
  '  const afterBlank = 2',
  '  ```',
  '',
  '- three',
  '',
  'Setext',
  '===',
  '',
  '    indented code',
  '',
  '    continues after a blank',
  '',
  '<div>',
  'html block',
  '',
  'still html?',
  '',
  '</div>',
  '',
  '> quoted',
  '',
  '> a second quote',
  '',
  '| a | b |',
  '| - | - |',
  '| 1 | 2 |',
  '',
  'Tail paragraph with a trailing partial wor',
].join('\n')

const REWIRING_DEFINITIONS: Readonly<Record<string, string>> = {
  'def-in-list': 'Read the [docs] first.\n\nReferences:\n\n- [docs]: https://example.com/docs',
  'def-in-ordered-list': 'Read the [ref] first.\n\nMore.\n\n1. [ref]: /u',
  'def-multiline-label': 'See [foo\nbar] here.\n\nMore.\n\n[foo\nbar]: https://x.y',
  'carriage-returns': 'a\r\nb\r\nc\r\nd\n\ne\r\nf\n\ng',
  'tab-line-in-table': '| a | b |\n| - | - |\nrow\n\t\nnext\n\nafter',
}

const DOCUMENTS: Readonly<Record<string, string>> = {
  ...CORPUS,
  spanning: SPANNING,
  ...REWIRING_DEFINITIONS,
}

const LINE_SHAPES: readonly string[] = [
  '',
  '',
  '',
  'plain words here',
  'more words with `code` and **bold**',
  '- bullet',
  '* star bullet',
  '1. ordered',
  '2) paren ordered',
  '  indented two',
  '    indented four',
  '> quoted',
  '> > nested quote',
  '# heading',
  '## heading two',
  '===',
  '---',
  '***',
  '```',
  '```ts',
  '  ```',
  '| a | b |',
  '| - | - |',
  '| 1 | 2 |',
  '<div>',
  '</div>',
  '<pre>',
  '</pre>',
  '<!-- comment -->',
  'Term',
  ': definition',
  '- [ ] task',
  'ends with two spaces  ',
  'ends with backslash\\',
  '[^n]: footnote',
  'refers [^n] here',
  'see [docs] and [foo',
  '- [docs]: https://example.com/docs',
  'bar]: /u',
  '\t',
  'carriage\r',
]

function seeded(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0
    return state / 2 ** 32
  }
}

function randomDocument(seed: number): string {
  const next = seeded(seed)
  const lines = Array.from(
    { length: 6 + Math.floor(next() * 14) },
    () => LINE_SHAPES[Math.floor(next() * LINE_SHAPES.length)] ?? '',
  )
  return lines.join('\n')
}

function cutPoints(source: string): readonly string[] {
  const cuts: string[] = []
  for (let end = 1; end <= source.length; end += 3) cuts.push(source.slice(0, end))
  cuts.push(source)
  return cuts
}

describe('growingProseBlocks', () => {
  for (const [name, source] of Object.entries(DOCUMENTS)) {
    it(`answers exactly what a one-shot parse would at every cut of ${name}`, () => {
      for (const cut of cutPoints(source)) {
        expect(growingProseBlocks(cut), `at ${cut.length} chars`).toEqual(sourcedProseBlocks(cut))
      }
    })
  }

  it('agrees with a one-shot parse across a few hundred random line salads', () => {
    for (let seed = 1; seed <= 300; seed += 1) {
      const source = randomDocument(seed)
      for (const cut of cutPoints(source)) {
        expect(growingProseBlocks(cut), `seed ${seed} at ${cut.length}:\n${cut}`).toEqual(
          sourcedProseBlocks(cut),
        )
      }
    }
  })

  it('hands back the same settled block objects once more text has streamed in behind them', () => {
    const settled = ['# Title', '', 'First paragraph.', '', '- a', '- b', '', '> quote', '', ''].join('\n')
    const before = growingProseBlocks(`${settled}Tail one`)
    const after = growingProseBlocks(`${settled}Tail one and more\n\nAnother paragraph`)

    expect(before.map((sourced) => sourced.block.kind)).toEqual([
      EProseBlock.Heading,
      EProseBlock.Paragraph,
      EProseBlock.List,
      EProseBlock.Quote,
      EProseBlock.Paragraph,
    ])
    expect(after.length).toBeGreaterThan(before.length)
    for (let index = 0; index < before.length - 1; index += 1) {
      expect(after[index], `block ${index}`).toBe(before[index])
    }
  })

  it('keeps a list live while a blank line inside it could still be followed by another bullet', () => {
    const before = growingProseBlocks('Lead.\n\n- a\n\n- b\n\n')
    const after = growingProseBlocks('Lead.\n\n- a\n\n- b\n\n- c')

    expect(after[0]).toBe(before[0])
    expect(after[1]).not.toBe(before[1])
    expect(after).toEqual(sourcedProseBlocks('Lead.\n\n- a\n\n- b\n\n- c'))
  })

  it('re-parses everything when a link reference definition is anywhere in the body', () => {
    const settled = 'A [ref] paragraph.\n\nSecond.\n\n'
    const before = growingProseBlocks(`${settled}tail`)
    const after = growingProseBlocks(`${settled}tail\n\n[ref]: https://example.com`)
    expect(after).toEqual(sourcedProseBlocks(`${settled}tail\n\n[ref]: https://example.com`))
    expect(after[0]).not.toBe(before[0])
  })

  it('reuses the streamed blocks when the same text is asked for settled', () => {
    const source = 'Streamed text.\n\nWith two paragraphs.'
    const grown = proseBlocksFor({ source, streaming: true })
    expect(proseBlocksFor({ source, streaming: false })).toBe(grown)
  })
})
