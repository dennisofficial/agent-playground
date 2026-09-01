import { describe, expect, it } from 'bun:test'

import { EFooterItemReach, footerItemCells } from '../../ui/footer-item'
import { glyph, theme } from '../../ui/theme'
import { shellsItem } from '../shells-surface'

const NEVER = (): void => undefined

describe('shellsItem', () => {
  it('says nothing when nothing has ever been run in the background', () => {
    expect(shellsItem({ running: 0, total: 0, onOpen: NEVER })).toBeNull()
  })

  it('spells how many of them are still going', () => {
    const item = shellsItem({ running: 1, total: 3, onOpen: NEVER })
    expect(item?.spans.map((span) => span.text).join('')).toBe(`${glyph.active} 1/3`)
    expect(item === null ? 0 : footerItemCells(item)).toBe(5)
    expect(item?.id).toBe('shells')
  })

  it('dims its mark once nothing is running, while still offering the log to read', () => {
    const idle = shellsItem({ running: 0, total: 2, onOpen: NEVER })
    expect(idle?.spans.map((span) => span.text).join('')).toBe(`${glyph.active} 0/2`)
    expect(idle?.spans[0]?.fg).toBe(theme.rule)

    const busy = shellsItem({ running: 2, total: 2, onOpen: NEVER })
    expect(busy?.spans[0]?.fg).toBe(theme.ok)
    expect(busy?.spans[0]?.fg).not.toBe(idle?.spans[0]?.fg)
  })

  it('spells the count in the same quiet tone whether or not anything is running', () => {
    const idle = shellsItem({ running: 0, total: 2, onOpen: NEVER })
    const busy = shellsItem({ running: 2, total: 2, onOpen: NEVER })
    expect(idle?.spans[1]?.fg).toBe(theme.hint)
    expect(busy?.spans[1]?.fg).toBe(theme.hint)
  })

  it('is reachable by the arrows and opens what it names', () => {
    const opened: string[] = []
    const item = shellsItem({ running: 1, total: 1, onOpen: () => opened.push('shells') })

    expect(item?.reach).toBe(EFooterItemReach.Keyboard)
    item?.onActivate?.()
    expect(opened).toEqual(['shells'])
  })
})
