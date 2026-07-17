export type QueryFormat = 'jsonl' | 'csv' | 'tsv';
export const QUERY_FORMATS: QueryFormat[] = ['jsonl', 'csv', 'tsv'];

/** Column order = union of keys in first-seen order across the (already row-capped) rows. */
export function columnsOf(rows: Record<string, unknown>[]): string[] {
  const seen = new Set<string>();
  const columns: string[] = [];
  for (const row of rows) {
    for (const key of Object.keys(row)) {
      if (!seen.has(key)) {
        seen.add(key);
        columns.push(key);
      }
    }
  }
  return columns;
}

function renderCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'object') return JSON.stringify(value);
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') {
    return value.toString();
  }
  if (typeof value === 'bigint' || typeof value === 'symbol') {
    return value.toString();
  }
  // A DB driver never returns a function-typed cell; this only exists to satisfy exhaustiveness.
  return typeof value === 'function' ? value.toString() : JSON.stringify(value);
}

function needsQuoting(cell: string, delimiter: string): boolean {
  return (
    cell.includes(delimiter) || cell.includes('"') || cell.includes('\r') || cell.includes('\n')
  );
}

function quoteCell(cell: string, delimiter: string): string {
  if (!needsQuoting(cell, delimiter)) return cell;
  return `"${cell.replace(/"/g, '""')}"`;
}

function renderDelimited(rows: Record<string, unknown>[], delimiter: string): string {
  const columns = columnsOf(rows);
  const header = columns.map((c) => quoteCell(c, delimiter)).join(delimiter);
  const lines = rows.map((row) =>
    columns.map((col) => quoteCell(renderCell(row[col]), delimiter)).join(delimiter),
  );
  return [header, ...lines].join('\n');
}

/** Render a row set into one of the line-delimited formats (one row per line). */
export function renderRows(rows: Record<string, unknown>[], format: QueryFormat): string {
  switch (format) {
    case 'jsonl':
      return rows.map((r) => JSON.stringify(r)).join('\n');
    case 'csv':
      return renderDelimited(rows, ',');
    case 'tsv':
      return renderDelimited(rows, '\t');
  }
}
