import { describe, expect, it } from 'bun:test'

import { EFooterItemReach, type FooterItem } from '../footer-item'
import {
  enterStrip,
  EStripCommand,
  moveStripSelection,
  reconcileStrip,
  selectedStripItem,
  stripCommand,
} from '../footer-strip'

const item = (over: Partial<FooterItem> & { id: string }): FooterItem => ({
  spans: [{ text: over.id }],
  reach: EFooterItemReach.Keyboard,
  onActivate: () => undefined,
  ...over,
})

const KEYBOARD = [item({ id: 'a' }), item({ id: 'b' })]

const SPLIT = [
  item({ id: 'lead', reach: EFooterItemReach.Pointer }),
  item({ id: 'a' }),
  item({ id: 'middle', reach: EFooterItemReach.Pointer }),
  item({ id: 'b' }),
]

describe('enterStrip', () => {
  it('lands on the first item the arrows can stop on', () => {
    expect(enterStrip(SPLIT)).toEqual({ itemId: 'a' })
  })

  it('declines an empty row', () => {
    expect(enterStrip([])).toBeNull()
  })

  it('declines a row nothing but the pointer can reach', () => {
    expect(enterStrip([item({ id: 'p', reach: EFooterItemReach.Pointer })])).toBeNull()
  })
})

describe('moveStripSelection', () => {
  it('steps over a pointer-only item sitting between two keyboard ones', () => {
    expect(moveStripSelection({ state: { itemId: 'a' }, items: SPLIT, delta: 1 })).toEqual({
      itemId: 'b',
    })
  })

  it('walks back the same way', () => {
    expect(moveStripSelection({ state: { itemId: 'b' }, items: SPLIT, delta: -1 })).toEqual({
      itemId: 'a',
    })
  })

  it('clamps at the right edge rather than wrapping round', () => {
    expect(moveStripSelection({ state: { itemId: 'b' }, items: KEYBOARD, delta: 1 })).toEqual({
      itemId: 'b',
    })
  })

  it('clamps at the left edge rather than wrapping round', () => {
    expect(moveStripSelection({ state: { itemId: 'a' }, items: KEYBOARD, delta: -1 })).toEqual({
      itemId: 'a',
    })
  })

  it('holds still when asked to move nowhere', () => {
    expect(moveStripSelection({ state: { itemId: 'a' }, items: KEYBOARD, delta: 0 })).toEqual({
      itemId: 'a',
    })
  })

  it('lands on the first item when what was held has already gone', () => {
    expect(moveStripSelection({ state: { itemId: 'gone' }, items: KEYBOARD, delta: 1 })).toEqual({
      itemId: 'a',
    })
  })
})

describe('reconcileStrip', () => {
  it('keeps a selection whose item is still there', () => {
    expect(reconcileStrip({ state: { itemId: 'b' }, items: KEYBOARD })).toEqual({ itemId: 'b' })
  })

  it('closes the strip when the held item leaves the row', () => {
    expect(reconcileStrip({ state: { itemId: 'b' }, items: [item({ id: 'a' })] })).toBeNull()
  })

  it('closes the strip when the held item degrades below the keyboard', () => {
    const degraded = [item({ id: 'b', reach: EFooterItemReach.Pointer })]
    expect(reconcileStrip({ state: { itemId: 'b' }, items: degraded })).toBeNull()
  })

  it('leaves a closed strip closed', () => {
    expect(reconcileStrip({ state: null, items: KEYBOARD })).toBeNull()
  })
})

describe('selectedStripItem', () => {
  it('names the item the selection points at', () => {
    expect(selectedStripItem({ state: { itemId: 'b' }, items: KEYBOARD })?.id).toBe('b')
  })

  it('names nothing when the strip is closed or the item has gone', () => {
    expect(selectedStripItem({ state: null, items: KEYBOARD })).toBeUndefined()
    expect(selectedStripItem({ state: { itemId: 'gone' }, items: KEYBOARD })).toBeUndefined()
  })
})

describe('stripCommand', () => {
  it('walks one item per arrow', () => {
    expect(stripCommand({ name: 'left' })).toEqual({ kind: EStripCommand.Move, delta: -1 })
    expect(stripCommand({ name: 'right' })).toEqual({ kind: EStripCommand.Move, delta: 1 })
  })

  it('activates on return', () => {
    expect(stripCommand({ name: 'return' })).toEqual({ kind: EStripCommand.Activate })
  })

  it('leaves on escape and on up', () => {
    expect(stripCommand({ name: 'escape' })).toEqual({ kind: EStripCommand.Leave })
    expect(stripCommand({ name: 'up' })).toEqual({ kind: EStripCommand.Leave })
  })

  it('swallows down rather than falling back out of the row it just entered', () => {
    expect(stripCommand({ name: 'down' })).toBeNull()
  })

  it('swallows a chord the strip has no use for', () => {
    expect(stripCommand({ name: 't', sequence: 't', ctrl: true })).toBeNull()
  })

  it('types a printable character back into the draft', () => {
    expect(stripCommand({ name: 'a', sequence: 'a' })).toEqual({
      kind: EStripCommand.TypeThrough,
      text: 'a',
    })
  })

  it('is not fooled by a control sequence that arrives as a character', () => {
    expect(stripCommand({ name: 'tab', sequence: '\t' })).toBeNull()
  })

  it('types a space, which is a character like any other', () => {
    expect(stripCommand({ name: 'space', sequence: ' ' })).toEqual({
      kind: EStripCommand.TypeThrough,
      text: ' ',
    })
  })

  it('swallows backspace however the terminal spells it, rather than typing DEL', () => {
    expect(stripCommand({ name: 'backspace', sequence: '\u007f' })).toBeNull()
    expect(stripCommand({ name: 'backspace', sequence: '\b' })).toBeNull()
  })

  it('swallows every other named key that edits rather than spelling something', () => {
    for (const name of ['delete', 'insert', 'home', 'end', 'pageup', 'pagedown', 'linefeed']) {
      expect(stripCommand({ name, sequence: '\u007f' })).toBeNull()
    }
  })
})
