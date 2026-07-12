import type { DataSource } from 'typeorm';

const STATEMENT_TIMEOUT = '10s';
const DEFAULT_ROWS = 1000;
const HARD_ROW_CEILING = 50_000;
/** Byte guard on the serialized (post row-cap) rows, independent of row count — a handful of huge rows
 *  (e.g. wide text/jsonb columns) can blow up a response even under the row cap. */
const MAX_RESULT_BYTES = 25 * 1024 * 1024; // 25 MB

/**
 * App-layer guard: accept only a single read-only SELECT/WITH statement. Layered on top of the
 * structural SELECT-only mcp_reader DB role. Trims, strips ONE trailing semicolon, requires the statement
 * to start with SELECT or WITH, and rejects any remaining embedded ';'.
 *
 * Accepted tradeoff (trusted users): a ';' inside a string literal (e.g. SELECT ';') is rejected. The
 * subquery wrap in runReadOnlyQuery is the real structural block on a smuggled second statement, and the
 * DB role blocks writes regardless.
 */
export function assertReadOnlySelect(raw: string): string {
  const trimmed = raw.trim().replace(/;\s*$/, '');
  if (trimmed === '') throw new Error('sql is required');
  if (!/^(select|with)\b/i.test(trimmed))
    throw new Error('only single read-only SELECT/WITH queries are allowed');
  if (trimmed.includes(';'))
    throw new Error('multiple statements are not allowed');
  return trimmed;
}

export async function runReadOnlyQuery(
  ds: DataSource,
  sql: string,
  params: unknown[],
  limit?: number,
): Promise<{ rows: unknown[]; rowCount: number; truncated: boolean }> {
  const vetted = assertReadOnlySelect(sql);
  const effective = Math.min(
    Math.max(limit ?? DEFAULT_ROWS, 1),
    HARD_ROW_CEILING,
  );
  const wrapped = `SELECT * FROM (\n${vetted}\n) AS __atlas_q LIMIT ${effective + 1}`;
  const qr = ds.createQueryRunner();
  try {
    await qr.connect();
    await qr.query('START TRANSACTION READ ONLY');
    try {
      await qr.query(`SET LOCAL statement_timeout = '${STATEMENT_TIMEOUT}'`);
      const rows: unknown[] = await qr.query(wrapped, params);
      let truncated = rows.length > effective;
      let kept = truncated ? rows.slice(0, effective) : rows;
      // Byte guard: even under the row cap, a handful of huge rows can produce an oversized payload.
      // Drop from the tail until the serialized size fits (or only one row remains).
      while (
        kept.length > 1 &&
        Buffer.byteLength(JSON.stringify(kept), 'utf8') > MAX_RESULT_BYTES
      ) {
        kept = kept.slice(0, -1);
        truncated = true;
      }
      return {
        rows: kept,
        rowCount: kept.length,
        truncated,
      };
    } finally {
      // ALWAYS end the transaction — on a query error or statement_timeout the txn is left aborted, and
      // releasing without rolling back returns a poisoned connection to the pool. .catch swallows
      // "no transaction in progress".
      await qr.query('ROLLBACK').catch(() => undefined);
      // A read-only SELECT can still invoke session-level functions (for example advisory locks). Reset
      // the pooled connection before returning it so one diagnostic query cannot affect the next call.
      await qr.query('DISCARD ALL').catch(() => undefined);
    }
  } finally {
    await qr.release();
  }
}

export async function introspectSchema(ds: DataSource): Promise<{
  tables: Array<{
    table: string;
    columns: Array<{ name: string; type: string; nullable: boolean }>;
  }>;
}> {
  const rows: Array<{
    table_name: string;
    column_name: string;
    data_type: string;
    is_nullable: string;
  }> = await ds.query(
    `SELECT table_name, column_name, data_type, is_nullable
       FROM information_schema.columns
      WHERE table_schema = 'public'
      ORDER BY table_name, ordinal_position`,
  );
  const byTable = new Map<
    string,
    Array<{ name: string; type: string; nullable: boolean }>
  >();
  for (const r of rows) {
    const cols = byTable.get(r.table_name) ?? [];
    cols.push({
      name: r.column_name,
      type: r.data_type,
      nullable: r.is_nullable === 'YES',
    });
    byTable.set(r.table_name, cols);
  }
  return {
    tables: [...byTable.entries()].map(([table, columns]) => ({
      table,
      columns,
    })),
  };
}
