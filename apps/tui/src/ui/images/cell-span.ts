export type CellSpan = {
  columns: number
  rows: number
}

export const SAMPLES_PER_CELL = 2

export const DEFAULT_CELL_ASPECT = 2

export const NO_ROOM: CellSpan = Object.freeze({ columns: 0, rows: 0 })

const rowsFor = (args: { columns: number; source: CellSpan; cellAspect: number }): number => {
  const pixelRatio = args.source.rows / args.source.columns
  return Math.max(1, Math.round((args.columns * pixelRatio) / args.cellAspect))
}

const columnsFor = (args: { rows: number; source: CellSpan; cellAspect: number }): number => {
  const pixelRatio = args.source.columns / args.source.rows
  return Math.max(1, Math.round(args.rows * pixelRatio * args.cellAspect))
}

export function imageCellSpan(args: {
  source: { width: number; height: number }
  availableColumns: number
  maxRows: number
  cellAspect?: number | undefined
  cellWidth?: number | undefined
}): CellSpan {
  if (args.availableColumns < 1 || args.maxRows < 1) return NO_ROOM
  if (args.source.width < 1 || args.source.height < 1) return NO_ROOM

  const cellAspect = args.cellAspect && args.cellAspect > 0 ? args.cellAspect : DEFAULT_CELL_ASPECT
  const cellWidth = args.cellWidth && args.cellWidth > 0 ? args.cellWidth : SAMPLES_PER_CELL
  const source: CellSpan = { columns: args.source.width, rows: args.source.height }
  const unscaled = Math.max(1, Math.round(args.source.width / cellWidth))

  const columns = Math.min(args.availableColumns, unscaled)
  const rows = rowsFor({ columns, source, cellAspect })
  if (rows <= args.maxRows) return { columns, rows }

  return {
    columns: Math.min(columns, columnsFor({ rows: args.maxRows, source, cellAspect })),
    rows: args.maxRows,
  }
}
