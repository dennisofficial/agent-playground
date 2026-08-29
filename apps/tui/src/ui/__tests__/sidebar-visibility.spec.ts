import { describe, expect, it } from 'bun:test'

import {
  ESidebarLayout,
  flipSidebar,
  sidebarChoiceInForce,
  sidebarLayout,
  sidebarShown,
  type SidebarChoice,
} from '../sidebar-visibility'

import { SIDEBAR_MIN_TERMINAL_WIDTH } from '../theme'

const WIDE = SIDEBAR_MIN_TERMINAL_WIDTH + 20

const NARROW = SIDEBAR_MIN_TERMINAL_WIDTH - 20

type Session = { layout: ESidebarLayout; choice: SidebarChoice | null }

const opened = (width: number): Session => ({ layout: sidebarLayout(width), choice: null })

const pressed = (session: Session): Session => ({
  layout: session.layout,
  choice: flipSidebar(session),
})

const resized = (args: { session: Session; width: number }): Session => {
  const layout = sidebarLayout(args.width)

  return { layout, choice: sidebarChoiceInForce({ layout, choice: args.session.choice }) }
}

describe('sidebar visibility', () => {
  it('shows itself on a wide terminal and hides on a narrow one', () => {
    expect(sidebarShown(opened(WIDE))).toBe(true)
    expect(sidebarShown(opened(NARROW))).toBe(false)
  })

  it('reads the threshold width itself as narrow', () => {
    expect(sidebarLayout(SIDEBAR_MIN_TERMINAL_WIDTH)).toBe(ESidebarLayout.Narrow)
  })

  it('folds away when the toggle is pressed on a wide terminal', () => {
    expect(sidebarShown(pressed(opened(WIDE)))).toBe(false)
  })

  it('opens as a peek when the toggle is pressed on a narrow terminal', () => {
    expect(sidebarShown(pressed(opened(NARROW)))).toBe(true)
  })

  it('comes back on widening after a narrow peek was closed again', () => {
    const peeked = pressed(opened(NARROW))
    const closed = pressed(peeked)
    expect(sidebarShown(closed)).toBe(false)

    expect(sidebarShown(resized({ session: closed, width: WIDE }))).toBe(true)
  })

  it('auto-collapses on narrowing after it was opened on a wide terminal', () => {
    const hidden = pressed(opened(WIDE))
    const shown = pressed(hidden)
    expect(sidebarShown(shown)).toBe(true)

    expect(sidebarShown(resized({ session: shown, width: NARROW }))).toBe(false)
  })

  it('forgets a hide made on a wide terminal once the terminal has been narrow', () => {
    const hidden = pressed(opened(WIDE))
    const narrowed = resized({ session: hidden, width: NARROW })

    expect(sidebarShown(resized({ session: narrowed, width: WIDE }))).toBe(true)
  })

  it('keeps a choice while the terminal only resizes within one layout', () => {
    const hidden = pressed(opened(WIDE))

    expect(sidebarShown(resized({ session: hidden, width: WIDE + 40 }))).toBe(false)
  })
})
