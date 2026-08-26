import { EDiffLine, type DiffHunk, type DiffLine, type DiffRow } from './hunk'

const pairedRows = (args: {
  removed: readonly DiffLine[]
  added: readonly DiffLine[]
}): DiffRow[] => {
  const { removed, added } = args
  const height = Math.max(removed.length, added.length)

  return Array.from({ length: height }, (_unused, index) => ({
    left: removed[index] ?? null,
    right: added[index] ?? null,
  }))
}

export function sideBySideRows(hunk: DiffHunk): DiffRow[] {
  const rows: DiffRow[] = []
  let removed: DiffLine[] = []
  let added: DiffLine[] = []

  const flush = (): void => {
    rows.push(...pairedRows({ removed, added }))
    removed = []
    added = []
  }

  for (const line of hunk.lines) {
    if (line.kind === EDiffLine.Removed) {
      if (added.length > 0) flush()
      removed.push(line)
      continue
    }

    if (line.kind === EDiffLine.Added) {
      added.push(line)
      continue
    }

    flush()
    rows.push({ left: line, right: line })
  }

  flush()
  return rows
}
