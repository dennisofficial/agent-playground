export const THINKING_TAIL_LINES = 10

export type Tailed<T> = {
  shown: T[]
  hidden: number
  notice: string | null
}

export function tail<T>(args: { items: readonly T[]; limit: number }): Tailed<T> {
  const { items, limit } = args
  if (items.length <= limit) return { shown: [...items], hidden: 0, notice: null }
  const hidden = items.length - limit
  return {
    shown: items.slice(items.length - limit),
    hidden,
    notice: `… +${hidden} line${hidden === 1 ? '' : 's'} above`,
  }
}

const NARROWEST_WRAP = 8

export function wrapWords(args: { text: string; width: number }): string[] {
  const { text, width } = args
  if (width < NARROWEST_WRAP) return [text.slice(0, Math.max(1, width))]

  const rows: string[] = []
  let line = ''
  const flush = (): void => {
    if (line.length > 0) rows.push(line)
    line = ''
  }

  for (const word of text.split(/\s+/).filter((part) => part.length > 0)) {
    let rest = word
    while (rest.length > width) {
      flush()
      rows.push(rest.slice(0, width))
      rest = rest.slice(width)
    }
    if (line.length === 0) line = rest
    else if (line.length + 1 + rest.length <= width) line += ` ${rest}`
    else {
      flush()
      line = rest
    }
  }
  flush()
  return rows.length > 0 ? rows : ['']
}

const SETTLED_WRAP_LIMIT = 8

const settledWrapCache = new Map<string, readonly string[]>()

/**
 * Every line before the final newline is frozen, so a growing stream rewraps only the trailing
 * partial line; the frozen rows are cached by their text and width.
 */
export function wrapStreamingLines(args: { text: string; width: number }): string[] {
  const lastBreak = args.text.lastIndexOf('\n')
  if (lastBreak < 0) return wrapWords(args)

  const settled = settledWrappedRows({
    prefix: args.text.slice(0, lastBreak),
    width: args.width,
  })
  return [...settled, ...wrapWords({ text: args.text.slice(lastBreak + 1), width: args.width })]
}

function settledWrappedRows(args: { prefix: string; width: number }): readonly string[] {
  const key = `${args.width}\n${args.prefix}`
  const hit = settledWrapCache.get(key)
  if (hit !== undefined) return hit

  const rows = args.prefix
    .split('\n')
    .flatMap((line) => wrapWords({ text: line, width: args.width }))
  if (settledWrapCache.size >= SETTLED_WRAP_LIMIT) settledWrapCache.clear()
  settledWrapCache.set(key, rows)
  return rows
}

const CHARS_PER_TOKEN = 4

export function thinkingSummary(text: string): string {
  const body = text.trim()
  if (body.length === 0) return 'Thinking…'
  const tokens = body.length / CHARS_PER_TOKEN
  const count =
    tokens >= 1_000
      ? `${(tokens / 1_000).toFixed(1)}K`
      : `${Math.max(10, Math.round(tokens / 10) * 10)}`
  return `Thinking… (~${count} tokens)`
}

