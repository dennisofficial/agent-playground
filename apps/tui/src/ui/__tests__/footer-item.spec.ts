import { describe, expect, it } from 'bun:test'

import {
  EFooterItemReach,
  footerItemCells,
  itemLadder,
  keyboardItems,
  pressOf,
  type FooterItem,
} from '../footer-item'

const item = (over: Partial<FooterItem> & { id: string }): FooterItem => ({
  spans: [{ text: over.id }],
  reach: EFooterItemReach.Keyboard,
  onActivate: () => undefined,
  ...over,
})

describe('footerItemCells', () => {
  it('sums every span the pill spells', () => {
    expect(footerItemCells(item({ id: 'pr', spans: [{ text: 'PR #123' }, { text: ' ✓' }] }))).toBe(
      9,
    )
  })

  it('counts codepoints, not UTF-16 units, so an emoji claims one cell of text', () => {
    expect(footerItemCells(item({ id: 'e', spans: [{ text: '🚀' }] }))).toBe(1)
    expect(footerItemCells(item({ id: 'c', spans: [{ text: '✓' }] }))).toBe(1)
  })

  it('is zero for a pill that spells nothing', () => {
    expect(footerItemCells(item({ id: 'none', spans: [] }))).toBe(0)
  })
})

describe('keyboardItems', () => {
  it('keeps what ←/→ can stop on and drops what it cannot', () => {
    const items = [
      item({ id: 'keyboard' }),
      item({ id: 'pointer', reach: EFooterItemReach.Pointer }),
      item({ id: 'decoration', reach: EFooterItemReach.None }),
    ]
    expect(keyboardItems(items).map((entry) => entry.id)).toEqual(['keyboard'])
  })

  it('drops a keyboard item that would do nothing when Enter reached it', () => {
    expect(keyboardItems([item({ id: 'inert', onActivate: undefined })])).toEqual([])
  })
})

describe('pressOf', () => {
  it('hands back the activation for anything a pointer may reach', () => {
    const onActivate = (): void => undefined
    expect(pressOf(item({ id: 'k', onActivate }))).toBe(onActivate)
    expect(pressOf(item({ id: 'p', reach: EFooterItemReach.Pointer, onActivate }))).toBe(onActivate)
  })

  it('hands back nothing for decoration, whatever it was given', () => {
    expect(pressOf(item({ id: 'd', reach: EFooterItemReach.None }))).toBeUndefined()
  })
})

describe('itemLadder', () => {
  it('sheds from the tail, one rung at a time, down to nothing', () => {
    const items = [item({ id: 'a' }), item({ id: 'b' }), item({ id: 'c' })]
    expect(itemLadder(items).map((rung) => rung.map((entry) => entry.id))).toEqual([
      ['a', 'b', 'c'],
      ['a', 'b'],
      ['a'],
      [],
    ])
  })

  it('has one rung when there was nothing to shed', () => {
    expect(itemLadder([])).toEqual([[]])
  })
})
