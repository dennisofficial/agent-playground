export type TableMetrics = {
  readonly columns: number
  readonly rows: number
}

export const TABLE_OPTIONS = { widthMode: 'content', cellPaddingX: 1 } as const

const CELL_PADDING = TABLE_OPTIONS.cellPaddingX * 2

const ALIGNMENT_ROW = /^[\s|:-]+$/

export function measureTable(markdown: string): TableMetrics {
  const rows = markdown
    .split('\n')
    .filter((line) => line.includes('|') && !ALIGNMENT_ROW.test(line))
    .map(cellsOf)

  if (rows.length === 0) return { columns: 0, rows: 0 }

  const columnCount = Math.max(...rows.map((cells) => cells.length))
  const widths = Array.from({ length: columnCount }, (_, column) =>
    Math.max(0, ...rows.map((cells) => cells[column]?.length ?? 0)),
  )

  return {
    columns: widths.reduce((total, width) => total + width + CELL_PADDING, 0) + columnCount + 1,
    rows: rows.length * 2 + 1,
  }
}

function cellsOf(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split(/(?<!\\)\|/)
    .map((cell) => cell.trim())
}
