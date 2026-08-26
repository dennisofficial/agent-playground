import { describe, expect, it } from 'bun:test'

import { EProseBlock, type ProseBlock, proseBlocks } from '../blocks'
import { EInline, inlinePlainText } from '../inline'

function textOf(block: ProseBlock | undefined): string {
  if (block === undefined) return ''
  if (block.kind === EProseBlock.Paragraph || block.kind === EProseBlock.Heading) {
    return inlinePlainText(block.content)
  }
  return ''
}

describe('heading blocks', () => {
  it('keeps the level, so the renderer can rank it rather than tint every level alike', () => {
    const blocks = proseBlocks('# One\n\n### Three')
    expect(blocks[0]).toMatchObject({ kind: EProseBlock.Heading, level: 1 })
    expect(blocks[1]).toMatchObject({ kind: EProseBlock.Heading, level: 3 })
    expect(textOf(blocks[0])).toBe('One')
  })
})

describe('list blocks', () => {
  it('nests a child list under the item that owns it rather than flattening it', () => {
    const [list] = proseBlocks('- one\n- two\n  - deep')
    if (list?.kind !== EProseBlock.List) throw new Error('expected a list')

    expect(list.items).toHaveLength(2)
    expect(inlinePlainText(list.items[1]?.content ?? [])).toBe('two')
    expect(list.items[1]?.children[0]).toMatchObject({ kind: EProseBlock.List })
  })

  it('reads a task item as checked or not, with the brackets already gone from the text', () => {
    for (const source of [
      '- [x] done\n- [ ] todo\n- plain',
      '- [x] done\n\n- [ ] todo\n\n- plain',
    ]) {
      const [list] = proseBlocks(source)
      if (list?.kind !== EProseBlock.List) throw new Error('expected a list')

      expect(
        list.items.map((item) => item.checked),
        source,
      ).toEqual([true, false, null])
      expect(inlinePlainText(list.items[0]?.content ?? []), source).toBe('done')
      expect(inlinePlainText(list.items[1]?.content ?? []), source).toBe('todo')
    }
  })

  it('carries the ordinal the source asked for, not a count from one', () => {
    const [list] = proseBlocks('7. seven\n8. eight')
    expect(list).toMatchObject({ kind: EProseBlock.List, ordered: true, start: 7 })
  })
})

describe('blockquote blocks', () => {
  it('nests one block per level, so the renderer draws a rail per level', () => {
    const [quote] = proseBlocks('> one\n>\n> > two\n> >\n> > > three')
    if (quote?.kind !== EProseBlock.Quote) throw new Error('expected a quote')

    const second = quote.children[1]
    if (second?.kind !== EProseBlock.Quote) throw new Error('expected a nested quote')
    expect(second.children[1]).toMatchObject({ kind: EProseBlock.Quote })
  })

  it('leaves no > marker anywhere in the text of any level', () => {
    const flat = JSON.stringify(proseBlocks('> one\n>\n> > two'))
    expect(flat).not.toContain('>')
  })
})

describe('footnotes', () => {
  it('lifts every definition out of the flow and collects them into a trailing block', () => {
    const blocks = proseBlocks('body[^1] and[^2].\n\n[^1]: first\n[^2]: second')

    expect(blocks).toHaveLength(2)
    expect(textOf(blocks[0])).toBe('body¹ and².')
    expect(blocks[1]).toMatchObject({ kind: EProseBlock.Footnotes })
  })

  it('numbers by definition order and folds an indented continuation into the note', () => {
    const [, notes] = proseBlocks('a[^x]\n\n[^x]: the note\n    carries on')
    if (notes?.kind !== EProseBlock.Footnotes) throw new Error('expected footnotes')

    expect(notes.notes[0]?.marker).toBe('¹')
    expect(inlinePlainText(notes.notes[0]?.content ?? [])).toBe('the note carries on')
  })

  it('emits no trailing block at all when the document defines none', () => {
    expect(proseBlocks('plain prose').some((b) => b.kind === EProseBlock.Footnotes)).toBe(false)
  })
})

describe('definition lists', () => {
  it('splits a term from its definitions, which marked alone reads as one paragraph', () => {
    const [list] = proseBlocks('Term\n: one\n: two')
    if (list?.kind !== EProseBlock.Definitions) throw new Error('expected definitions')

    expect(inlinePlainText(list.term)).toBe('Term')
    expect(list.definitions.map(inlinePlainText)).toEqual(['one', 'two'])
  })

  it('leaves an ordinary two-line paragraph alone', () => {
    expect(proseBlocks('one\ntwo')[0]).toMatchObject({ kind: EProseBlock.Paragraph })
  })
})

describe('blocks that keep their own renderer', () => {
  it('hands a nested fence back with its language, rather than as prose', () => {
    const [list] = proseBlocks('- item\n\n  ```ts\n  const x = 1\n  ```')
    if (list?.kind !== EProseBlock.List) throw new Error('expected a list')

    expect(list.items[0]?.children[0]).toEqual({
      kind: EProseBlock.Code,
      language: 'ts',
      source: 'const x = 1',
    })
  })

  it('marks a thematic break as a rule rather than leaking three dashes', () => {
    expect(proseBlocks('---')[0]).toEqual({ kind: EProseBlock.Rule })
  })
})

describe('inline content inside blocks', () => {
  it('resolves a footnote reference that sits inside a list item', () => {
    const [list] = proseBlocks('- see[^n]\n\n[^n]: note')
    if (list?.kind !== EProseBlock.List) throw new Error('expected a list')

    expect(list.items[0]?.content.at(-1)).toMatchObject({ kind: EInline.Footnote, marker: '¹' })
  })
})
