export type Range = { start: number; end: number }

type Run = Range & { length: number }

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

export function codeSpanRanges(text: string): readonly Range[] {
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

export const rangesCover = ({ ranges, at }: { ranges: readonly Range[]; at: number }): boolean =>
  ranges.some((range) => at >= range.start && at < range.end)
