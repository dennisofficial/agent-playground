const OPENERS: Readonly<Record<string, string>> = { '(': ')', '[': ']', '{': '}' }
const CLOSERS: readonly string[] = [')', ']', '}']

const withoutTrailingComment = (value: string): string => {
  for (let at = 0; at < value.length; at += 1) {
    if (value[at] !== '#') continue
    const before = at === 0 ? ' ' : (value[at - 1] ?? ' ')
    if (/\s/.test(before)) return value.slice(0, at)
  }
  return value
}

export const unquoted = (value: string): string => {
  const trimmed = value.trim()
  const head = trimmed[0]
  if (head === undefined) return trimmed
  if ((head === '"' || head === "'") && trimmed.endsWith(head) && trimmed.length > 1) {
    return trimmed.slice(1, -1)
  }
  return trimmed
}

export const scalarOf = (raw: string): string => {
  const trimmed = raw.trim()
  const head = trimmed[0]
  if (head === '"' || head === "'") {
    const closing = trimmed.indexOf(head, 1)
    return closing === -1 ? trimmed.slice(1) : trimmed.slice(1, closing)
  }
  return withoutTrailingComment(trimmed).trim()
}

export function splitOutsideGroups(args: {
  text: string
  isSeparator: (character: string) => boolean
}): readonly string[] {
  const pieces: string[] = []
  let current = ''
  let depth = 0
  let quote: string | undefined

  for (const character of args.text) {
    if (quote !== undefined) {
      current += character
      if (character === quote) quote = undefined
      continue
    }
    if (character === '"' || character === "'") {
      quote = character
      current += character
      continue
    }
    if (OPENERS[character] !== undefined) {
      depth += 1
      current += character
      continue
    }
    if (CLOSERS.includes(character)) {
      depth = depth === 0 ? 0 : depth - 1
      current += character
      continue
    }
    if (depth === 0 && args.isSeparator(character)) {
      pieces.push(current)
      current = ''
      continue
    }
    current += character
  }

  pieces.push(current)
  return pieces.map((piece) => piece.trim()).filter((piece) => piece !== '')
}
