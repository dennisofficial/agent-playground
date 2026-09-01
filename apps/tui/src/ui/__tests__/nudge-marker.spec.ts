import { ERiskDimension } from '@dltech/atlas-core'
import { describe, expect, it } from 'bun:test'

import type { ClassifierFold } from '../../store/classifier-fold'
import { EFooterItemReach, type FooterItem } from '../footer-item'
import { footerLayout } from '../footer-layout'
import { NUDGE_MARKER_ID, NUDGE_MARKER_TEXT, withNudgeMarker } from '../nudge-marker'

const PILL: FooterItem = {
  id: 'pr',
  spans: [{ text: '#412 draft' }],
  reach: EFooterItemReach.Pointer,
}

const fold = (over: Partial<ClassifierFold> = {}): ClassifierFold => ({
  pauses: 1,
  turns: 20,
  topDimension: ERiskDimension.Contention,
  quietedCalls: 0,
  judgeUnreachable: false,
  ...over,
})

const idsOf = (items: readonly FooterItem[]): string[] => items.map((item) => item.id)

describe('the marker that says the nudge is running blind', () => {
  it('appears when the judge could not be reached this turn', () => {
    const items = withNudgeMarker({ items: [PILL], fold: fold({ judgeUnreachable: true }) })

    expect(idsOf(items)).toEqual(['pr', NUDGE_MARKER_ID])
    expect(NUDGE_MARKER_TEXT).toContain('offline')
  })

  it('stays away while the judge is answering', () => {
    expect(idsOf(withNudgeMarker({ items: [PILL], fold: fold() }))).toEqual(['pr'])
  })

  it('stays away when the classifier has weighed nothing at all', () => {
    expect(withNudgeMarker({ items: [PILL], fold: undefined })).toEqual([PILL])
    expect(withNudgeMarker({ items: [PILL], fold: null })).toEqual([PILL])
  })

  it('answers no gesture, because there is nothing behind it to open', () => {
    const marker = withNudgeMarker({ items: [], fold: fold({ judgeUnreachable: true }) })[0]

    expect(marker?.reach).toBe(EFooterItemReach.None)
    expect(marker?.onActivate).toBeUndefined()
  })

  it('is the first thing the footer sheds when the terminal is too narrow', () => {
    const items = withNudgeMarker({ items: [PILL], fold: fold({ judgeUnreachable: true }) })
    const laid = footerLayout({ width: 30, model: 'sonnet', items })

    expect(idsOf(laid.instruments.items)).not.toContain(NUDGE_MARKER_ID)
  })
})
