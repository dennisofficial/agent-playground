import { describe, expect, it } from 'bun:test'

import { applyTerminalFocus, ETerminalFocus, subscribeTerminalFocus, terminalFocus } from '../focus-store'

describe('focus-store', () => {
  it('starts unknown', () => {
    expect(terminalFocus()).toBe(ETerminalFocus.Unknown)
  })

  it('transitions and notifies subscribers', () => {
    const seen: ETerminalFocus[] = []
    const unsubscribe = subscribeTerminalFocus(() => seen.push(terminalFocus()))

    applyTerminalFocus(ETerminalFocus.Blurred)
    applyTerminalFocus(ETerminalFocus.Focused)
    unsubscribe()

    expect(seen).toEqual([ETerminalFocus.Blurred, ETerminalFocus.Focused])
    expect(terminalFocus()).toBe(ETerminalFocus.Focused)
  })

  it('does not notify when the state repeats', () => {
    let notified = 0
    const unsubscribe = subscribeTerminalFocus(() => {
      notified += 1
    })

    applyTerminalFocus(ETerminalFocus.Focused)
    applyTerminalFocus(ETerminalFocus.Focused)
    unsubscribe()

    expect(notified).toBe(0)
  })

  it('stops notifying after unsubscribe', () => {
    let notified = 0
    const unsubscribe = subscribeTerminalFocus(() => {
      notified += 1
    })
    unsubscribe()

    applyTerminalFocus(ETerminalFocus.Blurred)

    expect(notified).toBe(0)
    applyTerminalFocus(ETerminalFocus.Unknown)
  })
})
