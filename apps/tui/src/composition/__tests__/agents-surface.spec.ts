import { describe, expect, it } from 'bun:test'

import { EFooterItemReach, footerItemCells } from '../../ui/footer-item'
import { theme } from '../../ui/theme'
import { subagentsItem } from '../agents-surface'

const NEVER = (): void => undefined

describe('subagentsItem', () => {
  it('says nothing while no child is running, however many have run before', () => {
    expect(subagentsItem({ running: 0, onOpen: NEVER })).toBeNull()
  })

  it('spells how many of them are going, and nothing else', () => {
    const item = subagentsItem({ running: 2, onOpen: NEVER })
    expect(item?.spans.map((span) => span.text).join('')).toBe('2 agents')
    expect(item === null ? 0 : footerItemCells(item)).toBe(8)
    expect(item?.id).toBe('subagents')
  })

  it('fills the chip in the crew purple, always the same while anything runs', () => {
    const item = subagentsItem({ running: 1, onOpen: NEVER })
    expect(item?.ground).toBe(theme.court.external)
    expect(item?.spans[0]?.fg).toBe(theme.appBg)
  })

  it('is reachable by the arrows and opens the crew it names', () => {
    const opened: string[] = []
    const item = subagentsItem({ running: 1, onOpen: () => opened.push('agents') })

    expect(item?.reach).toBe(EFooterItemReach.Keyboard)
    item?.onActivate?.()
    expect(opened).toEqual(['agents'])
  })
})
