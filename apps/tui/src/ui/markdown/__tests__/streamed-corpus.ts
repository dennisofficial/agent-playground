import type { CapturedFrame } from '@opentui/core'

export const CORPUS_WIDTH = 64

export const CORPUS_HEIGHT = 90

export const CHUNK_SIZES: readonly number[] = [20, 7]

export const CORPUS: Readonly<Record<string, string>> = {
  'loose-lists': [
    'Three ways the queue drains, in **rough** order of cost:',
    '',
    '- The fast path, which never touches disk.',
    '',
    '- The slow path, which does. It also wraps onto a second row',
    '  because the sentence keeps going for a while longer.',
    '',
    '  A second paragraph inside the same item.',
    '',
    '- The `mixed` path, with a nested list:',
    '  - inner one',
    '  - inner two',
    '    1. deep ordered',
    '    2. deeper still',
    '',
    '1. First numbered',
    '2. Second numbered',
    '',
    '3. Third after a gap',
    '',
    '- [ ] an open task',
    '- [x] a closed task',
    '',
    'Closing paragraph after the lists.',
    '',
  ].join('\n'),

  'quotes-setext': [
    'Setext Title',
    '============',
    '',
    'Some lead text with a hard break  ',
    'landing on the next row, and a backslash break\\',
    'landing on another.',
    '',
    '> A quoted paragraph that runs past the width of the panel so it',
    '> wraps inside the rail.',
    '>',
    '> > Nested quote line.',
    '>',
    '> - a list inside the quote',
    '> - with two items',
    '',
    'Subheading',
    '----------',
    '',
    '---',
    '',
    'After the rule, with *emphasis* and ~~strike~~ and a [link](https://example.com/path).',
    '',
    '### Level three',
    '',
    'Term',
    ': first definition',
    ': second definition',
    '',
  ].join('\n'),

  tables: [
    'Table one:',
    '',
    '| Engine | Model | Notes |',
    '| --- | --- | --- |',
    '| claude | opus | a long note that runs past sixty-four columns for sure |',
    '| codex | gpt | short |',
    '',
    'Between the tables.',
    '',
    '| a | b |',
    '| --- | --- |',
    '| 1 | 2 |',
    '',
    'After both tables.',
  ].join('\n'),

  'footnotes-defs': [
    'A claim with a footnote[^one] and another[^two] in the same line.',
    '',
    'A reference-style [link][atlas] and a bare [atlas] reference.',
    '',
    '[atlas]: https://example.com/atlas',
    '',
    '[^one]: The first note, which continues',
    '    onto an indented line.',
    '[^two]: The second note.',
    '',
    'Trailing text that mentions [^one] again.',
  ].join('\n'),

  'fence-in-list': [
    '1. Install it:',
    '',
    '   ```sh',
    '   bun install',
    '   ```',
    '',
    '2. Then run:',
    '',
    '   ```ts',
    '   const x: number = 1',
    '   ```',
    '',
    'A top-level fence follows.',
    '',
    '```ts queue.ts',
    'export const drain = (jobs: readonly Job[]): void => {',
    '  for (const job of jobs) job.run()',
    '}',
    '```',
    '',
    '<details>',
    '<summary>An html block</summary>',
    '',
    'Hidden body',
    '',
    '</details>',
    '',
    '    indented code block',
    '    second line',
    '',
    'Trailing partial wor',
  ].join('\n'),

  'long-prose': Array.from({ length: 6 }, (_, index) =>
    [
      `## Section ${index + 1}`,
      '',
      `Paragraph ${index + 1} explains the change in enough words to wrap at least twice inside a sixty-four column frame, with \`code\` and **bold**.`,
      '',
      `A second paragraph for section ${index + 1}, shorter.`,
    ].join('\n'),
  ).join('\n\n'),
}

export function styledLines(frame: CapturedFrame): readonly string[] {
  const lines = frame.lines.map((line) =>
    line.spans
      .map((span) => {
        const fg = span.fg.toInts().join(',')
        const bg = span.bg.toInts().join(',')
        return `${JSON.stringify(span.text)}<${fg}|${bg}|${span.attributes}>`
      })
      .join(''),
  )
  while (lines.length > 0 && /^"\s*"<[^>]*>$/.test(lines.at(-1) ?? '')) lines.pop()
  return lines
}

export function chunked(source: string, size: number): readonly string[] {
  const cuts: string[] = []
  for (let end = size; end < source.length; end += size) cuts.push(source.slice(0, end))
  cuts.push(source)
  return cuts
}
