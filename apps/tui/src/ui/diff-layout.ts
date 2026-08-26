import { EDiffLine, type DiffHunk, type DiffLine, type DiffRow } from '@dltech/atlas-core'

import { SIDE_BY_SIDE_MIN_TERMINAL_WIDTH } from './theme'

export enum EDiffMode {
  Inline = 'inline',
  SideBySide = 'side-by-side',
}

export const SIGN_COLUMNS = 1

export const GAP_COLUMNS = 1

export const DIVIDER_COLUMNS = 1

export const MIN_CODE_COLUMNS = 4

export const MIN_NUMBER_COLUMNS = 2

export function diffMode(args: { width: number }): EDiffMode {
  return args.width >= SIDE_BY_SIDE_MIN_TERMINAL_WIDTH ? EDiffMode.SideBySide : EDiffMode.Inline
}

export type InlineColumns = {
  numbers: number
  numberGap: number
  sign: number
  signGap: number
  code: number
}

export type SideColumns = {
  code: number
  numberGap: number
  numbers: number
}

export type SideBySideColumns = {
  left: SideColumns
  divider: number
  right: SideColumns
}

type Budget = { left: number }

function take(args: { budget: Budget; want: number }): number {
  const got = Math.max(0, Math.min(Math.trunc(args.want), args.budget.left))
  args.budget.left -= got
  return got
}

function budgetFor(width: number): { budget: Budget; floor: number } {
  const total = Math.max(0, Math.trunc(width))
  const floor = Math.min(total, MIN_CODE_COLUMNS)
  return { budget: { left: total - floor }, floor }
}

export function inlineColumns(args: { width: number; digits: number }): InlineColumns {
  const { budget, floor } = budgetFor(args.width)
  const sign = take({ budget, want: SIGN_COLUMNS })
  const signGap = take({ budget, want: GAP_COLUMNS })
  const numbers = take({ budget, want: Math.max(0, args.digits) })
  const numberGap = take({ budget, want: GAP_COLUMNS })
  return { numbers, numberGap, sign, signGap, code: floor + budget.left }
}

export function inlineWidth(columns: InlineColumns): number {
  return columns.numbers + columns.numberGap + columns.sign + columns.signGap + columns.code
}

export function sideColumns(args: { width: number; digits: number }): SideColumns {
  const { budget, floor } = budgetFor(args.width)
  const numbers = take({ budget, want: Math.max(0, args.digits) })
  const numberGap = take({ budget, want: GAP_COLUMNS })
  return { code: floor + budget.left, numberGap, numbers }
}

export function sideBySideColumns(args: { width: number; digits: number }): SideBySideColumns {
  const total = Math.max(0, Math.trunc(args.width))
  const divider = Math.min(DIVIDER_COLUMNS, total)
  const rest = total - divider
  const left = rest - Math.floor(rest / 2)
  return {
    left: sideColumns({ width: left, digits: args.digits }),
    divider,
    right: sideColumns({ width: rest - left, digits: args.digits }),
  }
}

export function sideBySideWidth(columns: SideBySideColumns): number {
  return (
    columns.left.code +
    columns.left.numberGap +
    columns.left.numbers +
    columns.divider +
    columns.right.numbers +
    columns.right.numberGap +
    columns.right.code
  )
}

export function numberDigits(args: { lines: readonly (DiffLine | null)[] }): number {
  const highest = args.lines.reduce(
    (max, line) => (line === null ? max : Math.max(max, line.oldNumber ?? 0, line.newNumber ?? 0)),
    0,
  )
  return Math.max(MIN_NUMBER_COLUMNS, String(highest).length)
}

export function rowDigits(args: { rows: readonly DiffRow[] }): number {
  return numberDigits({ lines: args.rows.flatMap((row) => [row.left, row.right]) })
}

export type HunkExtent = {
  oldStart: number
  oldCount: number
  newStart: number
  newCount: number
}

export function hunkExtent(args: { hunk: DiffHunk }): HunkExtent {
  let oldCount = 0
  let newCount = 0
  for (const line of args.hunk.lines) {
    if (line.kind === EDiffLine.Elision) {
      oldCount += line.elided ?? 0
      newCount += line.elided ?? 0
      continue
    }
    if (line.kind !== EDiffLine.Added) oldCount += 1
    if (line.kind !== EDiffLine.Removed) newCount += 1
  }
  return {
    oldStart: args.hunk.oldStart,
    oldCount,
    newStart: args.hunk.newStart,
    newCount,
  }
}

export function hunkMarker(args: { hunk: DiffHunk }): string {
  const extent = hunkExtent(args)
  return `@@ -${extent.oldStart},${extent.oldCount} +${extent.newStart},${extent.newCount} @@`
}
