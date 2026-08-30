import { codeSpanRanges, rangesCover } from '../text/backticks'

export type Mention = { start: number; end: number; name: string }

const isSpace = (character: string): boolean => /\s/.test(character)
const startsName = (character: string): boolean => /[A-Za-z]/.test(character)
const continuesName = (character: string): boolean => /[A-Za-z0-9:-]/.test(character)

function nameAt({ text, from }: { text: string; from: number }): Mention | null {
  const head = text[from]
  if (head === undefined || !startsName(head)) return null

  let end = from + 1
  while (end < text.length) {
    const character = text[end]
    if (character === undefined || !continuesName(character)) break
    end += 1
  }

  const name = text.slice(from, end)
  if (name.endsWith(':') || name.endsWith('-')) return null

  return { start: from - 1, end, name }
}

export function mentionSpans(text: string): readonly Mention[] {
  const suppressed = codeSpanRanges(text)
  const mentions: Mention[] = []
  let index = 0

  while (index < text.length) {
    if (text[index] !== '/') {
      index += 1
      continue
    }

    const before = index === 0 ? undefined : text[index - 1]
    if (before !== undefined && !isSpace(before)) {
      index += 1
      continue
    }

    const found = nameAt({ text, from: index + 1 })
    if (found === null) {
      index += 1
      continue
    }

    const after = text[found.end]
    if (after !== undefined && !isSpace(after)) {
      index = found.end
      continue
    }

    if (!rangesCover({ ranges: suppressed, at: index })) mentions.push(found)
    index = found.end
  }

  return mentions
}

export const MAX_CHAINED_COMMANDS = 6

export type CommandLine = { names: readonly string[]; argumentText: string }

export function commandLineOf(text: string): CommandLine | null {
  const mentions = mentionSpans(text)
  const first = mentions[0]
  if (first === undefined || first.start !== 0) return null

  const names = [first.name]
  let cursor = first.end

  for (const mention of mentions.slice(1)) {
    if (names.length >= MAX_CHAINED_COMMANDS) break
    if (text.slice(cursor, mention.start).trim() !== '') break

    names.push(mention.name)
    cursor = mention.end
  }

  return { names, argumentText: text.slice(cursor).trim() }
}
