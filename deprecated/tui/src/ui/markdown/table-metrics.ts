export type TableMetrics = {
  /** Columns the table needs to render without wrapping any cell. */
  readonly columns: number;
  /** Rows the table occupies, borders included. */
  readonly rows: number;
};

export const TABLE_OPTIONS = { widthMode: "content", cellPaddingX: 1 } as const;

/** Columns each cell spends on `TABLE_OPTIONS.cellPaddingX` — one on each side. */
const CELL_PADDING = TABLE_OPTIONS.cellPaddingX * 2;

/** Matches the `| --- | :-: |` alignment row, which is chrome rather than content. */
const DELIMITER = /^[\s|:-]+$/;

export function measureTable(markdown: string): TableMetrics {
  const rows = markdown
    .split("\n")
    .filter((line) => line.includes("|") && !DELIMITER.test(line))
    .map(cellsOf);

  if (rows.length === 0) return { columns: 0, rows: 0 };

  const columnCount = Math.max(...rows.map((cells) => cells.length));
  const widths = Array.from({ length: columnCount }, (_, column) =>
    Math.max(0, ...rows.map((cells) => cells[column]?.length ?? 0)),
  );

  return {
    columns:
      widths.reduce((total, width) => total + width + CELL_PADDING, 0) +
      columnCount +
      1,
    rows: rows.length * 2 + 1,
  };
}

function cellsOf(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split(/(?<!\\)\|/)
    .map((cell) => cell.trim());
}
