import { TextAttributes } from '@opentui/core'

import { glyph, theme } from '../../theme'
import type { InlineMarks } from './inline'

export const FOOTNOTE_RULE_CELLS = 8

export const RULE_CHAR = '─'

export const QUOTE_RAIL = '▌'

export const LINK_ARROW = '↗'

export const DEFINITION_MARKER = '›'

export const TASK_CHECKED = '✓'

export const TASK_UNCHECKED = glyph.available

const BULLETS = ['•', '◦'] as const

const LETTERS = 'abcdefghijklmnopqrstuvwxyz'

export type Ink = { readonly fg: string; readonly attributes: number }

export function headingInk(level: number): Ink {
  if (level <= 1) return { fg: theme.userFg, attributes: TextAttributes.BOLD }
  if (level === 2) return { fg: theme.accent, attributes: TextAttributes.BOLD }
  if (level === 3) return { fg: theme.hover, attributes: TextAttributes.BOLD }
  if (level === 4) return { fg: theme.meta, attributes: TextAttributes.BOLD }
  if (level === 5) return { fg: theme.meta, attributes: TextAttributes.NONE }
  return { fg: theme.hint, attributes: TextAttributes.NONE }
}

export function markAttributes(marks: InlineMarks): number {
  return (
    (marks.bold === true ? TextAttributes.BOLD : 0) |
    (marks.italic === true ? TextAttributes.ITALIC : 0) |
    (marks.strike === true ? TextAttributes.STRIKETHROUGH : 0)
  )
}

export function markForeground(args: { marks: InlineMarks; ground: string }): string {
  if (args.marks.strike === true) return theme.hint
  if (args.marks.bold === true) return theme.userFg
  return args.ground
}

export function bulletFor(depth: number): string {
  return (BULLETS[Math.min(depth, BULLETS.length - 1)] ?? BULLETS[0]) as string
}

export function ordinalFor(args: { index: number; depth: number }): string {
  if (args.depth === 0) return String(args.index)
  return LETTERS[(args.index - 1) % LETTERS.length] ?? String(args.index)
}

export function markerInk(args: { ordered: boolean; depth: number }): string {
  if (!args.ordered) return theme.hint
  return args.depth === 0 ? theme.meta : theme.hint
}

export function quoteRailInk(level: number): string {
  if (level <= 0) return theme.hint
  if (level === 1) return theme.meta
  return theme.body
}

export function inlineCodeSlab(blockBackground: string | undefined): string {
  return blockBackground === theme.userBg ? theme.hoverBg : theme.userBg
}

export function itemForeground(depth: number): string {
  return depth === 0 ? theme.hover : theme.body
}
