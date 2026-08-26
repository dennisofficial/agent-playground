import { EDiffLine, type DiffLine } from '@dltech/atlas-core'
import { pathToFiletype } from '@opentui/core'

import { codeTheme, EDiffLineKind } from '../../markdown/themes/index'
import { theme } from '../../theme'

/** U+2212 MINUS SIGN, not the hyphen a patch file uses: the sign column is typeset, not quoted. */
export const MINUS_SIGN = '−'

export const PLUS_SIGN = '+'

export const ELISION_GLYPH = '⋯'

export const DIVIDER_GLYPH = '│'

export type DiffTone = {
  kind: EDiffLineKind
  tint: string | undefined
  sign: string
  signFg: string
  contentFg: string | undefined
  dim: boolean
}

const KIND_OF: Readonly<Record<EDiffLine, EDiffLineKind>> = {
  [EDiffLine.Context]: EDiffLineKind.context,
  [EDiffLine.Added]: EDiffLineKind.added,
  [EDiffLine.Removed]: EDiffLineKind.removed,
  [EDiffLine.Elision]: EDiffLineKind.gap,
}

const SIGN_OF: Readonly<Record<EDiffLineKind, string>> = {
  [EDiffLineKind.context]: ' ',
  [EDiffLineKind.added]: PLUS_SIGN,
  [EDiffLineKind.removed]: MINUS_SIGN,
  [EDiffLineKind.gap]: ' ',
}

function tintOf(kind: EDiffLineKind): string | undefined {
  if (kind === EDiffLineKind.added) return theme.diff.addBg
  if (kind === EDiffLineKind.removed) return theme.diff.removeBg
  if (kind === EDiffLineKind.gap) return theme.diff.bandBg
  return undefined
}

function signFgOf(kind: EDiffLineKind): string {
  if (kind === EDiffLineKind.added) return theme.ok
  if (kind === EDiffLineKind.removed) return theme.error
  return theme.diff.gutterFg
}

export function diffTone(args: { kind: EDiffLine }): DiffTone {
  const kind = KIND_OF[args.kind]
  return {
    kind,
    tint: tintOf(kind),
    sign: SIGN_OF[kind],
    signFg: signFgOf(kind),
    contentFg: kind === EDiffLineKind.gap ? theme.hint : undefined,
    dim: codeTheme().diffRows[kind].content.dim === true,
  }
}

export function fitRight(args: { text: string; columns: number }): string {
  if (args.columns <= 0) return ''
  const padded = args.text.padStart(args.columns)
  return padded.slice(padded.length - args.columns)
}

export function fitLeft(args: { text: string; columns: number }): string {
  if (args.columns <= 0) return ''
  return args.text.padEnd(args.columns).slice(0, args.columns)
}

export function numberText(args: {
  line: DiffLine | null
  number: number | null
  columns: number
}): string {
  if (args.line === null) return ' '.repeat(Math.max(0, args.columns))
  if (args.line.kind === EDiffLine.Elision)
    return fitRight({ text: ELISION_GLYPH, columns: args.columns })
  if (args.number === null) return ' '.repeat(Math.max(0, args.columns))
  return fitRight({ text: String(args.number), columns: args.columns })
}

export function inlineNumber(line: DiffLine): number | null {
  return line.newNumber ?? line.oldNumber
}

export function elisionLabel(args: { elided: number }): string {
  return `${args.elided} unchanged line${args.elided === 1 ? '' : 's'}`
}

export function lineText(line: DiffLine): string {
  if (line.kind !== EDiffLine.Elision) return line.text
  return elisionLabel({ elided: line.elided ?? 0 })
}

export function filetypeOf(args: { path: string }): string {
  return pathToFiletype(args.path) ?? 'text'
}
