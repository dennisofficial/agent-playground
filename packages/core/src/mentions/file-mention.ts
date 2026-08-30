import { codeSpanRanges, rangesCover } from '../text/backticks'

export type FileMention = { start: number; end: number; path: string }

const SIGIL = '@'

const isSpace = (character: string): boolean => /\s/.test(character)
const continuesPath = (character: string): boolean => /[A-Za-z0-9._\-/~+#]/.test(character)
const isSentencePunctuation = (character: string): boolean => /[.,;:!?]/.test(character)

function pathAt({ text, from }: { text: string; from: number }): FileMention | null {
  let end = from
  while (end < text.length) {
    const character = text[end]
    if (character === undefined || !continuesPath(character)) break
    end += 1
  }

  while (end > from) {
    const last = text[end - 1]
    if (last === undefined || !isSentencePunctuation(last)) break
    end -= 1
  }

  if (end === from) return null

  return { start: from - 1, end, path: text.slice(from, end) }
}

export function fileMentionSpans(text: string): readonly FileMention[] {
  const suppressed = codeSpanRanges(text)
  const mentions: FileMention[] = []
  let index = 0

  while (index < text.length) {
    if (text[index] !== SIGIL) {
      index += 1
      continue
    }

    const before = index === 0 ? undefined : text[index - 1]
    if (before !== undefined && !isSpace(before)) {
      index += 1
      continue
    }

    const found = pathAt({ text, from: index + 1 })
    if (found === null) {
      index += 1
      continue
    }

    if (!rangesCover({ ranges: suppressed, at: index })) mentions.push(found)
    index = found.end
  }

  return mentions
}

export function mentionedFilePaths(text: string): readonly string[] {
  return [...new Set(fileMentionSpans(text).map((mention) => mention.path))]
}

export function resolvedFileMentions(args: {
  text: string
  known: ReadonlySet<string>
}): readonly FileMention[] {
  return fileMentionSpans(args.text).filter((mention) => args.known.has(mention.path))
}

export function activeFilePathQuery(text: string): string | null {
  let start = text.length
  while (start > 0) {
    const character = text[start - 1]
    if (character === undefined || !continuesPath(character)) break
    start -= 1
  }

  if (text[start - 1] !== SIGIL) return null

  const sigilAt = start - 1
  const before = sigilAt === 0 ? undefined : text[sigilAt - 1]
  if (before !== undefined && !isSpace(before)) return null
  if (rangesCover({ ranges: codeSpanRanges(text), at: sigilAt })) return null

  return text.slice(start)
}

export function completedFilePath(args: {
  text: string
  path: string
  settled?: boolean
}): string {
  const query = activeFilePathQuery(args.text)
  if (query === null) return args.text

  const start = args.text.length - query.length - 1
  const tail = args.settled === false ? '' : ' '

  return `${args.text.slice(0, start)}${SIGIL}${args.path}${tail}`
}
