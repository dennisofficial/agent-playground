import type { Span } from './components/spans'
import { cellsOf } from './hint-layout'

/**
 * Three states rather than two booleans set against each other: `Keyboard` stops the arrows, fires
 * on Enter and on a click; `Pointer` fires on a click while the arrows walk past it; `None` is
 * decoration that no gesture reaches.
 */
export enum EFooterItemReach {
  Keyboard = 'keyboard',
  Pointer = 'pointer',
  None = 'none',
}

export type FooterItem = {
  id: string
  spans: readonly Span[]
  reach: EFooterItemReach
  onActivate?: (() => void) | undefined
}

export const NO_FOOTER_ITEMS: readonly FooterItem[] = []

export const footerItemCells = (item: FooterItem): number =>
  item.spans.reduce((total, span) => total + cellsOf(span.text), 0)

export const keyboardItems = (items: readonly FooterItem[]): readonly FooterItem[] =>
  items.filter((item) => item.reach === EFooterItemReach.Keyboard && item.onActivate !== undefined)

export const pressOf = (item: FooterItem): (() => void) | undefined =>
  item.reach === EFooterItemReach.None ? undefined : item.onActivate

export function itemLadder(items: readonly FooterItem[]): readonly (readonly FooterItem[])[] {
  return Array.from({ length: items.length + 1 }, (unused, dropped) =>
    items.slice(0, items.length - dropped),
  )
}
