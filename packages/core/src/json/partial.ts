import type { JsonValue } from './value'

enum EScan {
  Value = 'value',
  Key = 'key',
  Colon = 'colon',
  Delimiter = 'delimiter',
  Text = 'text',
  Number = 'number',
  Literal = 'literal',
}

type Frame = { closer: '}' | ']'; safeEnd: number }

const WHITESPACE = new Set([' ', '\n', '\r', '\t'])
const UNENDABLE_NUMBER_TAIL = new Set(['.', 'e', 'E', '+', '-'])
const LITERALS = new Set(['true', 'false', 'null'])
const HEX_QUAD = /^[0-9a-fA-F]{4}$/

const isDigit = (char: string): boolean => char >= '0' && char <= '9'
const startsNumber = (char: string): boolean => char === '-' || isDigit(char)
const endsToken = (char: string): boolean =>
  char === ',' || char === '}' || char === ']' || WHITESPACE.has(char)

function readableTextEnd(args: { text: string; quoteAt: number }): number {
  const { text } = args
  let cursor = args.quoteAt + 1
  let readable = cursor

  while (cursor < text.length) {
    if (text[cursor] !== '\\') {
      cursor += 1
      readable = cursor
      continue
    }

    const escaped = text[cursor + 1]
    if (escaped === undefined) return readable

    if (escaped !== 'u') {
      cursor += 2
      readable = cursor
      continue
    }

    if (!HEX_QUAD.test(text.slice(cursor + 2, cursor + 6))) return readable
    cursor += 6
    readable = cursor
  }

  return readable
}

function endableNumberEnd(args: { text: string; from: number }): number {
  let end = args.text.length
  while (end > args.from && UNENDABLE_NUMBER_TAIL.has(args.text[end - 1] as string)) end -= 1
  return end
}

function completable(text: string): string {
  const stack: Frame[] = []
  let state = EScan.Value
  let tokenAt = 0
  let readingKey = false
  let escaped = false

  const innermostSafeEnd = (): number => stack.at(-1)?.safeEnd ?? 0

  const completedAt = (end: number) => {
    const frame = stack.at(-1)
    if (frame !== undefined) frame.safeEnd = end
    state = EScan.Delimiter
  }

  for (let cursor = 0; cursor < text.length; cursor += 1) {
    const char = text[cursor] as string

    if (state === EScan.Text) {
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === '"') {
        if (readingKey) state = EScan.Colon
        else completedAt(cursor + 1)
      }
      continue
    }

    if (state === EScan.Number || state === EScan.Literal) {
      if (!endsToken(char)) continue
      completedAt(cursor)
    }

    if (WHITESPACE.has(char)) continue

    if (char === '{' || char === '[') {
      stack.push({ closer: char === '{' ? '}' : ']', safeEnd: cursor + 1 })
      state = char === '{' ? EScan.Key : EScan.Value
      continue
    }

    if (char === '}' || char === ']') {
      stack.pop()
      completedAt(cursor + 1)
      continue
    }

    if (char === ',') {
      state = stack.at(-1)?.closer === '}' ? EScan.Key : EScan.Value
      continue
    }

    if (char === ':') {
      state = EScan.Value
      continue
    }

    if (char === '"') {
      readingKey = state === EScan.Key
      state = EScan.Text
      tokenAt = cursor
      continue
    }

    tokenAt = cursor
    state = startsNumber(char) ? EScan.Number : EScan.Literal
  }

  const closers: string[] = []
  let cut = text.length

  if (state === EScan.Text && readingKey) cut = innermostSafeEnd()
  else if (state === EScan.Text) {
    cut = readableTextEnd({ text, quoteAt: tokenAt })
    closers.push('"')
  } else if (state === EScan.Number) {
    const end = endableNumberEnd({ text, from: tokenAt })
    cut = end > tokenAt ? end : innermostSafeEnd()
  } else if (state === EScan.Literal) {
    cut = LITERALS.has(text.slice(tokenAt)) ? text.length : innermostSafeEnd()
  } else if (state === EScan.Value || state === EScan.Key || state === EScan.Colon) {
    cut = innermostSafeEnd()
  }

  for (let depth = stack.length - 1; depth >= 0; depth -= 1) {
    closers.push((stack[depth] as Frame).closer)
  }

  return text.slice(0, cut) + closers.join('')
}

const parsed = (text: string): JsonValue | undefined => {
  try {
    return JSON.parse(text) as JsonValue
  } catch {
    return undefined
  }
}

export function readPartialJson(text: string): JsonValue | undefined {
  if (text.trim() === '') return undefined

  const whole = parsed(text)
  if (whole !== undefined) return whole

  const repaired = completable(text)
  return repaired.trim() === '' ? undefined : parsed(repaired)
}
