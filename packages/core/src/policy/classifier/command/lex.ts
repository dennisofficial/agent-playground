import {
  expandPlainText,
  takeExpansion,
  type Expansion,
  type ExpansionSink,
  type VariableResolver,
} from './expansion'
import { matchOperator, readHeredocDelimiter } from './operators'

export enum ETokenKind {
  Word = 'word',
  Operator = 'operator',
}

export type LexedToken = {
  kind: ETokenKind
  text: string
  expansions: readonly Expansion[]
  isHeredocBody: boolean
}

export type LexResult = {
  tokens: readonly LexedToken[]
  unterminated: boolean
}

type Draft = ExpansionSink & { open: boolean }

type Heredoc = {
  delimiter: string
  stripsTabs: boolean
  expands: boolean
}

const leadingTabs = /^\t+/

const freshDraft = (): Draft => ({ text: '', expansions: [], open: false })

export function lexCommand(args: {
  command: string
  resolveVariable?: VariableResolver | undefined
}): LexResult {
  const source = args.command
  const resolve = args.resolveVariable
  const tokens: LexedToken[] = []
  const heredocs: Heredoc[] = []
  let draft = freshDraft()
  let unterminated = false
  let index = 0

  const emit = ({
    kind,
    text,
    expansions,
  }: {
    kind: ETokenKind
    text: string
    expansions: readonly Expansion[]
  }): void => {
    tokens.push({ kind, text, expansions, isHeredocBody: false })
  }

  const flush = (): void => {
    if (!draft.open) return
    emit({ kind: ETokenKind.Word, text: draft.text, expansions: draft.expansions })
    draft = freshDraft()
  }

  const readSingleQuoted = (start: number): number => {
    draft.open = true
    const close = source.indexOf("'", start + 1)
    if (close === -1) {
      draft.text += source.slice(start + 1)
      unterminated = true
      return source.length
    }
    draft.text += source.slice(start + 1, close)
    return close + 1
  }

  const readDoubleQuoted = (start: number): number => {
    draft.open = true
    let cursor = start + 1

    while (cursor < source.length) {
      const char = source[cursor]
      if (char === '"') return cursor + 1

      if (char === '\\') {
        const next = source[cursor + 1]
        if (next === undefined) {
          unterminated = true
          return cursor + 1
        }
        if (next === '\n') {
          cursor += 2
          continue
        }
        if (next === '"' || next === '\\' || next === '$' || next === '`') {
          draft.text += next
          cursor += 2
          continue
        }
        draft.text += char
        cursor += 1
        continue
      }

      if (char === '$' || char === '`') {
        const next = takeExpansion({ source, at: cursor, sink: draft, resolve })
        if (next !== undefined) {
          cursor = next
          continue
        }
      }

      draft.text += char
      cursor += 1
    }

    unterminated = true
    return cursor
  }

  const consumeHeredocBodies = (from: number): number => {
    let cursor = from

    for (const doc of heredocs) {
      const lines: string[] = []
      let closed = false

      while (cursor < source.length) {
        const lineEnd = source.indexOf('\n', cursor)
        const raw = lineEnd === -1 ? source.slice(cursor) : source.slice(cursor, lineEnd)
        cursor = lineEnd === -1 ? source.length : lineEnd + 1
        const line = doc.stripsTabs ? raw.replace(leadingTabs, '') : raw
        if (line === doc.delimiter) {
          closed = true
          break
        }
        lines.push(line)
      }

      if (!closed) unterminated = true

      const sink: ExpansionSink = { text: '', expansions: [] }
      const body = lines.join('\n')
      if (doc.expands) expandPlainText({ source: body, sink, resolve })
      else sink.text = body
      tokens.push({
        kind: ETokenKind.Word,
        text: sink.text,
        expansions: sink.expansions,
        isHeredocBody: true,
      })
    }

    heredocs.length = 0
    return cursor
  }

  while (index < source.length) {
    const char = source[index]

    if (char === '\\') {
      const next = source[index + 1]
      if (next === undefined) {
        unterminated = true
        index += 1
        continue
      }
      if (next === '\n') {
        index += 2
        continue
      }
      draft.open = true
      draft.text += next
      index += 2
      continue
    }

    if (char === "'") {
      index = readSingleQuoted(index)
      continue
    }

    if (char === '"') {
      index = readDoubleQuoted(index)
      continue
    }

    if (char === '$' || char === '`') {
      const next = takeExpansion({ source, at: index, sink: draft, resolve })
      if (next !== undefined) {
        draft.open = true
        index = next
        continue
      }
    }

    if (char === ' ' || char === '\t' || char === '\r') {
      flush()
      index += 1
      continue
    }

    const operator = matchOperator({ source, at: index, midWord: draft.open })
    if (operator !== undefined) {
      flush()

      if (operator.text === '<<' || operator.text === '<<-') {
        const delimiter = readHeredocDelimiter({ source, at: operator.next })
        if (delimiter === undefined) {
          unterminated = true
          index = operator.next
          continue
        }
        heredocs.push({
          delimiter: delimiter.delimiter,
          stripsTabs: operator.text === '<<-',
          expands: delimiter.expands,
        })
        index = delimiter.next
        continue
      }

      if (operator.text === '\n' && heredocs.length > 0) {
        index = consumeHeredocBodies(operator.next)
        emit({ kind: ETokenKind.Operator, text: '\n', expansions: [] })
        continue
      }

      emit({ kind: ETokenKind.Operator, text: operator.text, expansions: [] })
      index = operator.next
      continue
    }

    draft.open = true
    draft.text += char
    index += 1
  }

  flush()
  if (heredocs.length > 0) unterminated = true

  return { tokens, unterminated }
}
