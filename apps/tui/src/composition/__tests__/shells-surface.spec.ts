import { describe, expect, it } from 'bun:test'

import { EFooterItemReach, footerItemCells } from '../../ui/footer-item'
import { theme } from '../../ui/theme'
import { shellsItem } from '../shells-surface'

const NEVER = (): void => undefined

describe('shellsItem', () => {
  it('says nothing while nothing is running, however many have run before', () => {
    expect(shellsItem({ running: 0, onOpen: NEVER })).toBeNull()
  })

  it('spells how many of them are going, and nothing else', () => {
    const item = shellsItem({ running: 1, onOpen: NEVER })
    expect(item?.spans.map((span) => span.text).join('')).toBe('1 shell')
    expect(item === null ? 0 : footerItemCells(item)).toBe(7)
    expect(item?.id).toBe('shells')
  })

  it('fills the chip white, always the same while anything runs', () => {
    const item = shellsItem({ running: 3, onOpen: NEVER })
    expect(item?.ground).toBe(theme.bright)
    expect(item?.spans[0]?.fg).toBe(theme.appBg)
  })

  it('is reachable by the arrows and opens what it names', () => {
    const opened: string[] = []
    const item = shellsItem({ running: 1, onOpen: () => opened.push('shells') })

    expect(item?.reach).toBe(EFooterItemReach.Keyboard)
    item?.onActivate?.()
    expect(opened).toEqual(['shells'])
  })
})
