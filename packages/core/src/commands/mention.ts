export type Mention = { start: number; end: number; name: string }

type Range = { start: number; end: number }
type Run = Range & { length: number }

const isSpace = (character: string): boolean => /\s/.test(character)
const startsName = (character: string): boolean => /[A-Za-z]/.test(character)
const continuesName = (character: string): boolean => /[A-Za-z0-9:-]/.test(character)

function backtickRuns(text: string): readonly Run[] {
  const runs: Run[] = []
  let index = 0

  while (index < text.length) {
    if (text[index] !== '`') {
      index += 1
      continue
    }

    const start = index
    while (index < text.length && text[index] === '`') index += 1
    runs.push({ start, end: index, length: index - start })
  }

  return runs
}

function suppressedRanges(text: string): readonly Range[] {
  const runs = backtickRuns(text)
  const ranges: Range[] = []
  let index = 0

  while (index < runs.length) {
    const open = runs[index]
    if (open === undefined) break

    const closingAt = runs.findIndex((run, at) => at > index && run.length === open.length)
    const closing = closingAt === -1 ? undefined : runs[closingAt]
    if (closing === undefined) {
      index += 1
      continue
    }

    ranges.push({ start: open.start, end: closing.end })
    index = closingAt + 1
  }

  return ranges
}

const covers = ({ ranges, at }: { ranges: readonly Range[]; at: number }): boolean =>
  ranges.some((range) => at >= range.start && at < range.end)

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
  const suppressed = suppressedRanges(text)
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

    if (!covers({ ranges: suppressed, at: index })) mentions.push(found)
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
