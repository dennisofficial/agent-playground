import {
  ELexRule,
  type LanguageSpec,
  type LexHighlight,
  type LexRule,
  type QuotedRule,
  type SpanRule,
} from './spec'

const DEFAULT_IDENTIFIER = /[A-Za-z_][A-Za-z0-9_]*/
const DEFAULT_NUMBER = /(?:0[xXbBoO][0-9A-Fa-f_]+|\d[\d_]*(?:\.\d[\d_]*)?(?:[eE][+-]?\d+)?)/
const DEFAULT_OPERATORS = '+-*/%<>=!&|^~'

const NEWLINE = 10
const TAB = 9
const SPACE = 32
const ZERO = 48
const NINE = 57

export type Scanner = (source: string) => readonly LexHighlight[]

type RuleMatch = { readonly end: number; readonly group: string }

export function createScanner(spec: LanguageSpec): Scanner {
  const identifier = sticky(spec.identifier ?? DEFAULT_IDENTIFIER)
  const number = sticky(spec.number ?? DEFAULT_NUMBER)
  const rules = (spec.rules ?? []).map((rule) => prepare(rule))
  const words = wordIndex(spec)
  const operators = spec.operators ?? DEFAULT_OPERATORS
  const fold = spec.caseInsensitive === true

  return function scan(source: string): readonly LexHighlight[] {
    const out: LexHighlight[] = []
    const length = source.length
    let index = 0
    let lineStart = 0
    let leading = true

    while (index < length) {
      const code = source.charCodeAt(index)

      if (code === NEWLINE) {
        index += 1
        lineStart = index
        leading = true
        continue
      }

      if (code === SPACE || code === TAB) {
        index += 1
        continue
      }

      const matched = matchRules({
        rules,
        source,
        index,
        column: index - lineStart,
        leading,
      })

      if (matched) {
        out.push([index, matched.end, matched.group])
        const lastBreak = source.lastIndexOf('\n', matched.end - 1)
        if (lastBreak >= index) lineStart = lastBreak + 1
        index = matched.end
        leading = false
        continue
      }

      leading = false

      identifier.lastIndex = index
      const word = identifier.exec(source)?.[0]
      if (word !== undefined && word.length > 0) {
        const group = words.get(fold ? word.toLowerCase() : word)
        const end = index + word.length
        if (group) out.push([index, end, group])
        else if (spec.call && opensCall({ source, index: end })) out.push([index, end, spec.call])
        index = end
        continue
      }

      if (code >= ZERO && code <= NINE) {
        number.lastIndex = index
        const digits = number.exec(source)?.[0]
        if (digits !== undefined && digits.length > 0) {
          out.push([index, index + digits.length, 'number'])
          index += digits.length
          continue
        }
      }

      if (operators.includes(source[index] ?? '')) {
        let end = index + 1
        while (end < length && operators.includes(source[end] ?? '')) end += 1
        out.push([index, end, 'operator'])
        index = end
        continue
      }

      index += 1
    }

    return out
  }
}

type PreparedRule = { readonly rule: LexRule; readonly pattern?: RegExp }

function prepare(rule: LexRule): PreparedRule {
  if (rule.kind === ELexRule.pattern) return { rule, pattern: sticky(rule.match) }
  return { rule }
}

function matchRules(args: {
  rules: readonly PreparedRule[]
  source: string
  index: number
  column: number
  leading: boolean
}): RuleMatch | null {
  for (const prepared of args.rules) {
    const { rule } = prepared
    if (rule.atLineStart === true && !args.leading) continue
    if (rule.atColumn !== undefined && rule.atColumn !== args.column) continue

    const end = matchRule({ prepared, source: args.source, index: args.index })
    if (end !== null && end > args.index) return { end, group: rule.group }
  }
  return null
}

function matchRule(args: {
  prepared: PreparedRule
  source: string
  index: number
}): number | null {
  const { rule, pattern } = args.prepared

  if (rule.kind === ELexRule.pattern) {
    if (!pattern) return null
    pattern.lastIndex = args.index
    const hit = pattern.exec(args.source)?.[0]
    return hit === undefined ? null : args.index + hit.length
  }

  if (!args.source.startsWith(rule.open, args.index)) return null

  if (rule.kind === ELexRule.line) {
    const stop = args.source.indexOf('\n', args.index)
    return stop === -1 ? args.source.length : stop
  }

  if (rule.kind === ELexRule.span) return closeSpan({ rule, source: args.source, index: args.index })

  return closeQuote({ rule, source: args.source, index: args.index })
}

function closeSpan(args: {
  rule: SpanRule
  source: string
  index: number
}): number {
  const { rule, source } = args
  let depth = 1
  let cursor = args.index + rule.open.length

  while (cursor < source.length) {
    if (source.startsWith(rule.close, cursor)) {
      depth -= 1
      cursor += rule.close.length
      if (depth === 0) return cursor
      continue
    }
    if (rule.nests === true && source.startsWith(rule.open, cursor)) {
      depth += 1
      cursor += rule.open.length
      continue
    }
    cursor += 1
  }

  return source.length
}

function closeQuote(args: {
  rule: QuotedRule
  source: string
  index: number
}): number {
  const { rule, source } = args
  const close = rule.close ?? rule.open
  let cursor = args.index + rule.open.length

  while (cursor < source.length) {
    const char = source[cursor]
    if (rule.escape !== undefined && char === rule.escape) {
      cursor += 2
      continue
    }
    if (char === '\n' && rule.multiline !== true) return cursor
    if (source.startsWith(close, cursor)) {
      if (rule.doubled === true && source.startsWith(close, cursor + close.length)) {
        cursor += close.length * 2
        continue
      }
      return cursor + close.length
    }
    cursor += 1
  }

  return source.length
}

function opensCall(args: { source: string; index: number }): boolean {
  let cursor = args.index
  while (cursor < args.source.length) {
    const char = args.source[cursor]
    if (char === ' ' || char === '\t') {
      cursor += 1
      continue
    }
    return char === '('
  }
  return false
}

function wordIndex(spec: LanguageSpec): ReadonlyMap<string, string> {
  const index = new Map<string, string>()
  for (const [group, words] of Object.entries(spec.words ?? {})) {
    for (const word of words) {
      index.set(spec.caseInsensitive === true ? word.toLowerCase() : word, group)
    }
  }
  return index
}

function sticky(pattern: RegExp): RegExp {
  return pattern.flags.includes('y')
    ? new RegExp(pattern.source, pattern.flags)
    : new RegExp(pattern.source, `${pattern.flags}y`)
}
