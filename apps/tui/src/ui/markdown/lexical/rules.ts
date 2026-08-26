import { ELexRule, type LineRule, type PatternRule, type QuotedRule, type SpanRule } from './spec'

export function lineComment(args: { open: string; atLineStart?: boolean; atColumn?: number }): LineRule {
  return {
    kind: ELexRule.line,
    open: args.open,
    group: 'comment',
    ...(args.atLineStart === undefined ? {} : { atLineStart: args.atLineStart }),
    ...(args.atColumn === undefined ? {} : { atColumn: args.atColumn }),
  }
}

export function blockComment(args: { open: string; close: string; nests?: boolean }): SpanRule {
  return {
    kind: ELexRule.span,
    open: args.open,
    close: args.close,
    group: 'comment',
    ...(args.nests === undefined ? {} : { nests: args.nests }),
  }
}

export function slashComments(): readonly [LineRule, SpanRule] {
  return [lineComment({ open: '//' }), blockComment({ open: '/*', close: '*/' })]
}

export function hashComment(): LineRule {
  return lineComment({ open: '#' })
}

export function dashComment(): LineRule {
  return lineComment({ open: '--' })
}

export function semicolonComment(): LineRule {
  return lineComment({ open: ';' })
}

export function percentComment(): LineRule {
  return lineComment({ open: '%' })
}

export function quoted(args: {
  open: string
  close?: string
  group?: string
  escape?: string | null
  doubled?: boolean
  multiline?: boolean
  atLineStart?: boolean
}): QuotedRule {
  return {
    kind: ELexRule.quoted,
    open: args.open,
    group: args.group ?? 'string',
    ...(args.close === undefined ? {} : { close: args.close }),
    ...(args.escape === null ? {} : { escape: args.escape ?? '\\' }),
    ...(args.doubled === undefined ? {} : { doubled: args.doubled }),
    ...(args.multiline === undefined ? {} : { multiline: args.multiline }),
    ...(args.atLineStart === undefined ? {} : { atLineStart: args.atLineStart }),
  }
}

export function doubleQuoted(args?: { escape?: string | null; multiline?: boolean }): QuotedRule {
  return quoted({ open: '"', escape: args?.escape ?? '\\', ...(args?.multiline === undefined ? {} : { multiline: args.multiline }) })
}

export function singleQuoted(args?: { escape?: string | null; doubled?: boolean }): QuotedRule {
  return quoted({
    open: "'",
    escape: args?.escape ?? '\\',
    ...(args?.doubled === undefined ? {} : { doubled: args.doubled }),
  })
}

export function backQuoted(): QuotedRule {
  return quoted({ open: '`', multiline: true })
}

export function tripleQuoted(): QuotedRule {
  return quoted({ open: '"""', escape: null, multiline: true })
}

export function pattern(args: { match: RegExp; group: string; atLineStart?: boolean }): PatternRule {
  return {
    kind: ELexRule.pattern,
    match: args.match,
    group: args.group,
    ...(args.atLineStart === undefined ? {} : { atLineStart: args.atLineStart }),
  }
}

export function sigilVariable(args: { sigil: string; group?: string; word?: string }): PatternRule {
  const word = args.word ?? '[A-Za-z_][A-Za-z0-9_]*'
  return pattern({
    match: new RegExp(`${escapeLiteral(args.sigil)}${word}`),
    group: args.group ?? 'variable',
  })
}

export function preprocessor(): PatternRule {
  return pattern({ match: /#[a-z]+/, group: 'keyword.directive', atLineStart: true })
}

export function annotation(): PatternRule {
  return pattern({ match: /@[A-Za-z_][A-Za-z0-9_]*/, group: 'attribute' })
}

export function typeByCase(): PatternRule {
  return pattern({ match: /[A-Z][A-Za-z0-9_]*/, group: 'type' })
}

export function variableByCase(): PatternRule {
  return pattern({ match: /[A-Z_][A-Za-z0-9_]*/, group: 'variable' })
}

function escapeLiteral(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
