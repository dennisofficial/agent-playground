import type { Span } from './components/spans'

/**
 * Two anchors rather than a free ordinal: the head of the column reads as facts about where the
 * session is, and everything below it is a panel with a heading. A contributed section names which
 * of the two it belongs to and takes its turn there in contribution order.
 */
export enum ESidebarPlace {
  Facts = 'facts',
  Panels = 'panels',
}

/**
 * A row may be a function of the column width because clipping cuts the tail, and for some rows the
 * tail is the reading nobody can afford to lose — a failing check count sits to the right of the
 * passing one. A fixed array is still accepted, and is right for a row that cannot degrade.
 */
export type SidebarRowSpans = readonly Span[] | ((cells: number) => readonly Span[])

export type SidebarSectionRow = {
  id: string
  spans: SidebarRowSpans
  onActivate?: (() => void) | undefined
}

export const spansOf = (args: { row: SidebarSectionRow; cells: number }): readonly Span[] =>
  typeof args.row.spans === 'function' ? args.row.spans(args.cells) : args.row.spans

export type SidebarSection = {
  id: string
  place: ESidebarPlace
  label?: string | undefined
  rows: readonly SidebarSectionRow[]
}

export const NO_SIDEBAR_SECTIONS: readonly SidebarSection[] = []

const PLACE_RANK: Record<ESidebarPlace, number> = {
  [ESidebarPlace.Facts]: 0,
  [ESidebarPlace.Panels]: 1,
}

const showing = (section: SidebarSection): boolean => section.rows.length > 0

export function orderSections(sections: readonly SidebarSection[]): readonly SidebarSection[] {
  const ranked = sections
    .filter(showing)
    .map((section, index) => ({ section, index }))
    .sort((left, right) => {
      const places = PLACE_RANK[left.section.place] - PLACE_RANK[right.section.place]
      return places === 0 ? left.index - right.index : places
    })

  return ranked.length === 0 ? NO_SIDEBAR_SECTIONS : ranked.map((entry) => entry.section)
}

export const sectionsAt = (args: {
  sections: readonly SidebarSection[]
  place: ESidebarPlace
}): readonly SidebarSection[] => args.sections.filter((section) => section.place === args.place)
