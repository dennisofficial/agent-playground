import { describe, expect, it } from 'bun:test'

import { EKeyGroup, EKeyLayer, pressHandled, type KeyPress } from '../../ui/keys'
import { globalBindings, type GlobalHandlers } from '../global-bindings'

const noop = () => undefined

const handlers = (over: Partial<GlobalHandlers>): GlobalHandlers => ({
  draftIsEmpty: () => true,
  onSubmit: noop,
  onShortcuts: noop,
  onTakeBackPending: () => true,
  onInterrupt: noop,
  onNewConversation: noop,
  onOpenSwitcher: noop,
  onOpenShells: noop,
  onToggleSidebar: noop,
  onOpenSettings: noop,
  onQuit: noop,
  ...over,
})

const placedFrom = (over: Partial<GlobalHandlers>) =>
  globalBindings(handlers(over)).map((binding, index) => ({ ...binding, placed: index + 1 }))

const press = (over: KeyPress): KeyPress => ({ ctrl: false, shift: false, meta: false, ...over })

describe('the keys the app itself owns', () => {
  it('binds every one of them at the global layer, so a block can take a chord back', () => {
    expect(globalBindings(handlers({})).every((one) => one.layer === EKeyLayer.Global)).toBe(true)
  })

  it('claims no chord twice', () => {
    const chords = globalBindings(handlers({})).map((one) => one.chord)

    expect(new Set(chords).size).toBe(chords.length)
  })

  it('documents every one of them under a group', () => {
    const groups = new Set(Object.values(EKeyGroup))

    expect(globalBindings(handlers({})).every((one) => groups.has(one.group as EKeyGroup))).toBe(
      true,
    )
  })

  it('opens the shortcuts list on ? when the draft is empty', () => {
    let asked = 0
    const bindings = placedFrom({ onShortcuts: () => void (asked += 1) })

    expect(pressHandled({ press: press({ sequence: '?' }), bindings })).toBe(true)
    expect(asked).toBe(1)
  })

  it('leaves ? to the composer once there is a draft to type it into', () => {
    let asked = 0
    const bindings = placedFrom({
      draftIsEmpty: () => false,
      onShortcuts: () => void (asked += 1),
    })

    expect(pressHandled({ press: press({ sequence: '?' }), bindings })).toBe(false)
    expect(asked).toBe(0)
  })

  it('leaves ↑ to the composer when there is a draft, and when nothing is queued', () => {
    const withDraft = placedFrom({ draftIsEmpty: () => false })
    const nothingQueued = placedFrom({ onTakeBackPending: () => false })

    expect(pressHandled({ press: press({ name: 'up' }), bindings: withDraft })).toBe(false)
    expect(pressHandled({ press: press({ name: 'up' }), bindings: nothingQueued })).toBe(false)
  })

  it('takes the last queued message back on ↑ when there is one', () => {
    expect(pressHandled({ press: press({ name: 'up' }), bindings: placedFrom({}) })).toBe(true)
  })

  it('sends on ⏎ but leaves shift+⏎ to the composer for a newline', () => {
    let sent = 0
    const bindings = placedFrom({ onSubmit: () => void (sent += 1) })

    expect(pressHandled({ press: press({ name: 'return' }), bindings })).toBe(true)
    expect(pressHandled({ press: press({ name: 'return', shift: true }), bindings })).toBe(false)
    expect(sent).toBe(1)
  })

  it('interrupts on esc and quits on ctrl+c', () => {
    const taken: string[] = []
    const bindings = placedFrom({
      onInterrupt: () => void taken.push('interrupt'),
      onQuit: () => void taken.push('quit'),
    })

    pressHandled({ press: press({ name: 'escape' }), bindings })
    pressHandled({ press: press({ name: 'c', ctrl: true }), bindings })

    expect(taken).toEqual(['interrupt', 'quit'])
  })
})
