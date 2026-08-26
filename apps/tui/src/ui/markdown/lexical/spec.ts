export enum ELexRule {
  line = 'line',
  span = 'span',
  quoted = 'quoted',
  pattern = 'pattern',
}

type RulePlacement = {
  readonly group: string
  readonly atLineStart?: boolean
  readonly atColumn?: number
}

export type LineRule = RulePlacement & {
  readonly kind: ELexRule.line
  readonly open: string
}

export type SpanRule = RulePlacement & {
  readonly kind: ELexRule.span
  readonly open: string
  readonly close: string
  readonly nests?: boolean
}

export type QuotedRule = RulePlacement & {
  readonly kind: ELexRule.quoted
  readonly open: string
  readonly close?: string
  readonly escape?: string
  readonly doubled?: boolean
  readonly multiline?: boolean
}

export type PatternRule = RulePlacement & {
  readonly kind: ELexRule.pattern
  readonly match: RegExp
}

export type LexRule = LineRule | SpanRule | QuotedRule | PatternRule

export type LexHighlight = readonly [start: number, end: number, group: string]

export type WordGroups = Readonly<Record<string, readonly string[]>>

export type LanguageSpec = {
  readonly filetype: string
  readonly aliases?: readonly string[]
  readonly rules?: readonly LexRule[]
  readonly words?: WordGroups
  readonly caseInsensitive?: boolean
  readonly identifier?: RegExp
  readonly number?: RegExp
  readonly call?: string
  readonly operators?: string
}
