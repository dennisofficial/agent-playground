import { describe, expect, it } from 'bun:test'

import {
  chromeWidthOf,
  contentWidthOf,
  ESidebarLayout,
  floatingSidebarWidth,
  peekInForce,
  sidebarFoldsAt,
  sidebarLayout,
  sidebarShown,
} from '../sidebar-visibility'

import { MIN_TRANSCRIPT_WIDTH, SIDEBAR_FOLD_BELOW, SIDEBAR_GUTTER, SIDEBAR_WIDTH } from '../theme'

const shipped = { foldBelow: SIDEBAR_FOLD_BELOW, sidebarWidth: SIDEBAR_WIDTH }

const layoutAt = (width: number) => sidebarLayout({ width, ...shipped })

type Session = { layout: ESidebarLayout; peeking: boolean }

const opened = (width: number): Session => ({ layout: layoutAt(width), peeking: false })

const pressed = (session: Session): Session => ({ ...session, peeking: !session.peeking })

const resized = (args: { session: Session; width: number }): Session => {
  const layout = layoutAt(args.width)

  return { layout, peeking: peekInForce({ layout, peeking: args.session.peeking }) }
}

describe('sidebar visibility', () => {
  it('docks on a wide terminal and folds away on a narrow one', () => {
    expect(sidebarShown(opened(SIDEBAR_FOLD_BELOW + 20))).toBe(true)
    expect(sidebarShown(opened(SIDEBAR_FOLD_BELOW - 20))).toBe(false)
  })

  it('reads the configured fold width itself as narrow', () => {
    expect(layoutAt(SIDEBAR_FOLD_BELOW)).toBe(ESidebarLayout.Narrow)
    expect(layoutAt(SIDEBAR_FOLD_BELOW + 1)).toBe(ESidebarLayout.Wide)
  })

  it('folds where the reader asked it to rather than at a fixed width', () => {
    const asked = { foldBelow: 90, sidebarWidth: SIDEBAR_WIDTH }

    expect(sidebarLayout({ width: 100, ...asked })).toBe(ESidebarLayout.Wide)
    expect(sidebarLayout({ width: 100, ...shipped })).toBe(ESidebarLayout.Narrow)
  })

  it('opens as an overlay when the toggle is pressed on a narrow terminal', () => {
    expect(sidebarShown(pressed(opened(SIDEBAR_FOLD_BELOW - 20)))).toBe(true)
  })

  it('closes the overlay again on a second press', () => {
    const peeked = pressed(opened(SIDEBAR_FOLD_BELOW - 20))

    expect(sidebarShown(pressed(peeked))).toBe(false)
  })

  it('drops the overlay on widening, where the sidebar is docked anyway', () => {
    const peeked = pressed(opened(SIDEBAR_FOLD_BELOW - 20))
    const widened = resized({ session: peeked, width: SIDEBAR_FOLD_BELOW + 20 })

    expect(widened.peeking).toBe(false)
    expect(sidebarShown(widened)).toBe(true)
  })

  it('folds closed on narrowing rather than carrying the docked sidebar over', () => {
    const docked = opened(SIDEBAR_FOLD_BELOW + 20)

    expect(sidebarShown(resized({ session: docked, width: SIDEBAR_FOLD_BELOW - 20 }))).toBe(false)
  })

  it('keeps the overlay open while the terminal only resizes within the narrow layout', () => {
    const peeked = pressed(opened(SIDEBAR_FOLD_BELOW - 20))

    expect(sidebarShown(resized({ session: peeked, width: SIDEBAR_FOLD_BELOW - 30 }))).toBe(true)
  })
})

describe('the width the sidebar refuses to dock at', () => {
  it('honours a fold width that leaves the transcript room', () => {
    expect(sidebarFoldsAt({ foldBelow: 160, sidebarWidth: SIDEBAR_WIDTH })).toBe(160)
  })

  it('overrides a fold width that would starve the transcript', () => {
    const starved = { foldBelow: 60, sidebarWidth: 64 }

    expect(sidebarFoldsAt(starved)).toBe(64 + SIDEBAR_GUTTER + MIN_TRANSCRIPT_WIDTH)
    expect(sidebarLayout({ width: 80, ...starved })).toBe(ESidebarLayout.Narrow)
  })

  it('leaves the transcript at least its minimum wherever it does dock', () => {
    for (const sidebarWidth of [30, 42, 64]) {
      for (const foldBelow of [60, 120, 240]) {
        const width = sidebarFoldsAt({ foldBelow, sidebarWidth }) + 1

        expect(sidebarLayout({ width, foldBelow, sidebarWidth })).toBe(ESidebarLayout.Wide)
        expect(chromeWidthOf({ width, sidebarWidth, docked: true })).toBeGreaterThanOrEqual(
          MIN_TRANSCRIPT_WIDTH,
        )
      }
    }
  })
})

describe('widths handed to the renderer', () => {
  it('never lets the floating sidebar reach past the terminal', () => {
    expect(floatingSidebarWidth({ width: 30, sidebarWidth: 64 })).toBe(30)
    expect(floatingSidebarWidth({ width: 200, sidebarWidth: 64 })).toBe(64)
  })

  it('gives the transcript the whole terminal while the sidebar floats', () => {
    expect(contentWidthOf({ width: 90, sidebarWidth: 42, docked: false })).toBe(90)
    expect(chromeWidthOf({ width: 90, sidebarWidth: 42, docked: false })).toBe(90)
  })

  it('takes the sidebar and its gutter out of the transcript while docked', () => {
    expect(contentWidthOf({ width: 200, sidebarWidth: 42, docked: true })).toBe(158)
    expect(chromeWidthOf({ width: 200, sidebarWidth: 42, docked: true })).toBe(158 - SIDEBAR_GUTTER)
  })

  it('stays positive even on a terminal narrower than the sidebar', () => {
    expect(contentWidthOf({ width: 20, sidebarWidth: 64, docked: true })).toBe(1)
    expect(chromeWidthOf({ width: 20, sidebarWidth: 64, docked: true })).toBe(1)
  })
})
