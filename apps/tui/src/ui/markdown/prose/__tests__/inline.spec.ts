import { marked } from 'marked'
import { describe, expect, it } from 'bun:test'

import { EInline, hostOf, type InlineNode, inlineNodes, inlinePlainText } from '../inline'
import { raiseSuperscripts, subscript, superscript, superscriptNumber } from '../unicode'

function nodesOf(source: string, order?: ReadonlyMap<string, number>): readonly InlineNode[] {
  return inlineNodes({ tokens: marked.lexer(source), ...(order === undefined ? {} : { order }) })
}

function textOf(source: string): string {
  return inlinePlainText(nodesOf(source))
}

describe('inline marks', () => {
  it('carries bold, italic and both at once without printing a delimiter', () => {
    const nodes = nodesOf('**a** *b* ***c***')
    expect(textOf('**a** *b* ***c***')).toBe('a b c')
    expect(nodes[0]).toMatchObject({ marks: { bold: true } })
    expect(nodes[2]).toMatchObject({ marks: { italic: true } })
    expect(nodes[4]).toMatchObject({ marks: { italic: true, bold: true } })
  })

  it('marks a double-tilde run struck, which no SyntaxStyle scope can express', () => {
    expect(nodesOf('~~gone~~')[0]).toEqual({
      kind: EInline.Text,
      text: 'gone',
      marks: { strike: true },
    })
  })

  it('reads a single-tilde run as a subscript instead, and falls back when no glyph exists', () => {
    expect(textOf('H~2~O')).toBe('H₂O')
    expect(nodesOf('a~qq~b')[1]).toMatchObject({ marks: { strike: true } })
  })

  it('leaves inline code unpadded, so no wrap can strand a lit cell', () => {
    expect(nodesOf('`useMemo`')[0]).toEqual({
      kind: EInline.Code,
      text: 'useMemo',
      marks: {},
    })
  })
})

describe('inline syntax that used to leak', () => {
  it('renders an escaped character and drops the backslash', () => {
    expect(textOf('\\*not italic\\*')).toBe('*not italic*')
    expect(textOf('\\[not a link\\]')).toBe('[not a link]')
  })

  it('raises a caret run to unicode and leaves an unmappable one alone', () => {
    expect(textOf('E=mc^2^')).toBe('E=mc²')
    expect(raiseSuperscripts('a^zz^b')).toBe('a^zz^b')
  })

  it('drops an HTML comment and keeps the rest of the block as prose', () => {
    expect(textOf('<!-- hidden --> and <b>shown</b>')).toBe(' and <b>shown</b>')
  })
})

describe('links and images', () => {
  it('keeps the label and the host, and never the path, the query or the title', () => {
    const [link] = nodesOf('[OpenAI](https://www.openai.com/index/hello?a=1 "Title")')
    expect(link).toMatchObject({ kind: EInline.Link, host: 'openai.com' })
    expect(inlinePlainText([link as InlineNode])).toBe('OpenAI')
  })

  it('falls back to the whole reference when there is no authority to name', () => {
    expect(hostOf('docs/spec.md')).toBe('docs/spec.md')
    expect(hostOf('mailto:a@b.com')).toBe('a@b.com')
  })

  it('splits an image into its alt text and its path', () => {
    expect(nodesOf('![Alt text](docs/spec.png)')[0]).toEqual({
      kind: EInline.Image,
      alt: 'Alt text',
      path: 'docs/spec.png',
    })
  })
})

describe('footnote references', () => {
  it('becomes a superscript numeral once the definition has claimed a position', () => {
    expect(nodesOf('see[^a]', new Map([['a', 2]]))[1]).toEqual({
      kind: EInline.Footnote,
      marker: '²',
    })
  })

  it('stays literal when nothing defines it, rather than inventing a number', () => {
    expect(textOf('see[^ghost]')).toBe('see[^ghost]')
  })
})

describe('unicode tables', () => {
  it('translates only runs where every point has a glyph', () => {
    expect(superscript('2')).toBe('²')
    expect(superscript('Q')).toBeNull()
    expect(subscript('2')).toBe('₂')
    expect(superscriptNumber(12)).toBe('¹²')
  })
})
