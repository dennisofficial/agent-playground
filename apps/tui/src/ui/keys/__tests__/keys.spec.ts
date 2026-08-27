import { describe, expect, it } from 'bun:test'

import {
  candidatesFor,
  EKeyLayer,
  pressHandled,
  type KeyBinding,
  type PlacedBinding,
} from '../binding'
import { chordMatches, spellChord, type KeyPress } from '../chord'
import { createKeyRegistry } from '../registry'

const press = (over: KeyPress): KeyPress => ({
  ctrl: false,
  shift: false,
  meta: false,
  ...over,
})

describe('matching a press against a chord', () => {
  it('takes a named key on its name', () => {
    expect(chordMatches({ chord: 'escape', press: press({ name: 'escape' }) })).toBe(true)
    expect(chordMatches({ chord: 'escape', press: press({ name: 'return' }) })).toBe(false)
  })

  it('takes a printable key on the sequence the terminal sent', () => {
    expect(chordMatches({ chord: '?', press: press({ sequence: '?' }) })).toBe(true)
  })

  it('will not fire a bare chord when a modifier was held', () => {
    expect(chordMatches({ chord: 'return', press: press({ name: 'return', ctrl: true }) })).toBe(
      false,
    )
    expect(chordMatches({ chord: 'return', press: press({ name: 'return', shift: true }) })).toBe(
      false,
    )
  })

  it('ignores the shift that produced a printable character, since it is not a chord', () => {
    expect(chordMatches({ chord: '?', press: press({ sequence: '?', shift: true }) })).toBe(true)
  })

  it('requires the exact modifier a chord names, and no other', () => {
    expect(chordMatches({ chord: 'ctrl+r', press: press({ name: 'r', ctrl: true }) })).toBe(true)
    expect(chordMatches({ chord: 'ctrl+r', press: press({ name: 'r' }) })).toBe(false)
    expect(
      chordMatches({ chord: 'ctrl+r', press: press({ name: 'r', ctrl: true, meta: true }) }),
    ).toBe(false)
  })

  it('spells a chord the way the shortcuts list shows it', () => {
    expect(spellChord('return')).toBe('⏎')
    expect(spellChord('escape')).toBe('esc')
    expect(spellChord('ctrl+r')).toBe('ctrl+r')
  })
})

const placed = (over: Partial<PlacedBinding> & { run: () => boolean | void }): PlacedBinding => ({
  chord: 'ctrl+r',
  hint: 'retry',
  layer: EKeyLayer.Global,
  placed: 1,
  ...over,
})

describe('deciding which binding owns a press', () => {
  const pressed = press({ name: 'r', ctrl: true })

  it('lets a block binding win over a global one on the same chord', () => {
    const taken: string[] = []
    const bindings = [
      placed({ layer: EKeyLayer.Global, placed: 1, run: () => void taken.push('global') }),
      placed({ layer: EKeyLayer.Block, placed: 2, run: () => void taken.push('block') }),
    ]

    pressHandled({ press: pressed, bindings })

    expect(taken).toEqual(['block'])
  })

  it('gives the press to the newest binding when two sit on the same layer', () => {
    const order = candidatesFor({
      press: pressed,
      bindings: [
        placed({ placed: 1, hint: 'older', run: () => undefined }),
        placed({ placed: 2, hint: 'newer', run: () => undefined }),
      ],
    })

    expect(order.map((binding) => binding.hint)).toEqual(['newer', 'older'])
  })

  it('passes the press on when a binding declines it', () => {
    const taken: string[] = []
    const bindings = [
      placed({ layer: EKeyLayer.Global, placed: 1, run: () => void taken.push('global') }),
      placed({ layer: EKeyLayer.Block, placed: 2, run: () => false }),
    ]

    expect(pressHandled({ press: pressed, bindings })).toBe(true)
    expect(taken).toEqual(['global'])
  })

  it('reports a press nobody wanted, so the composer still gets the key', () => {
    expect(pressHandled({ press: pressed, bindings: [] })).toBe(false)
    expect(
      pressHandled({ press: pressed, bindings: [placed({ run: () => false })] }),
    ).toBe(false)
  })

  it('treats a handler that returns nothing as having taken the press', () => {
    expect(pressHandled({ press: pressed, bindings: [placed({ run: () => undefined })] })).toBe(true)
  })
})

const binding = (over: Partial<KeyBinding>): KeyBinding => ({
  chord: 'ctrl+r',
  hint: 'retry',
  layer: EKeyLayer.Block,
  run: () => undefined,
  ...over,
})

describe('the registry a mounted component binds into', () => {
  it('holds nothing until something registers', () => {
    expect(createKeyRegistry().snapshot()).toEqual([])
  })

  it('drops a binding again when the component that owned it unmounts', () => {
    const registry = createKeyRegistry()
    const release = registry.register([binding({})])

    expect(registry.snapshot()).toHaveLength(1)

    release()

    expect(registry.snapshot()).toEqual([])
  })

  it('returns the same snapshot until the bound set actually changes', () => {
    const registry = createKeyRegistry()
    registry.register([binding({})])
    const first = registry.snapshot()

    expect(registry.snapshot()).toBe(first)

    registry.register([binding({ chord: 'ctrl+b' })])

    expect(registry.snapshot()).not.toBe(first)
  })

  it('tells its listeners when the bound set changes', () => {
    const registry = createKeyRegistry()
    let notices = 0
    registry.subscribe(() => void (notices += 1))

    const release = registry.register([binding({})])
    release()

    expect(notices).toBe(2)
  })

  it('stamps later registrations as newer, so precedence follows mount order', () => {
    const registry = createKeyRegistry()
    registry.register([binding({ hint: 'older' })])
    registry.register([binding({ hint: 'newer' })])

    const [older, newer] = registry.snapshot()

    expect(older?.placed).toBeLessThan(newer?.placed ?? 0)
  })
})
