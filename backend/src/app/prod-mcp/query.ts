import type { DataSource } from 'typeorm';

const STATEMENT_TIMEOUT = '10s';
const DEFAULT_ROWS = 1000;
const HARD_ROW_CEILING = 50_000;
export const MAX_RESULT_BYTES = 25 * 1024 * 1024; // 25 MB

function effectiveLimit(limit: number | undefined): number {
  if (limit !== undefined && !Number.isFinite(limit)) {
    throw new Error('limit must be a finite number');
  }
  return Math.min(Math.max(Math.floor(limit ?? DEFAULT_ROWS), 1), HARD_ROW_CEILING);
}

export function assertReadOnlySelect(raw: string): string {
  const trimmed = raw.trim().replace(/;\s*$/, '');
  if (trimmed === '') throw new Error('sql is required');
  if (!/^(select|with)\b/i.test(trimmed))
    throw new Error('only single read-only SELECT/WITH queries are allowed');
  if (trimmed.includes(';')) throw new Error('multiple statements are not allowed');
  return trimmed;
}

export async function runReadOnlyQuery(
  ds: DataSource,
  sql: string,
  params: unknown[],
  limit?: number,
): Promise<{ rows: unknown[]; rowCount: number; truncated: boolean }> {
  const vetted = assertReadOnlySelect(sql);
  const effective = effectiveLimit(limit);
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
      if (kept.length > 0) {
        let total = 2; // '[' + ']'
        let fit = 0;
        for (let i = 0; i < kept.length; i++) {
          const rowBytes = Buffer.byteLength(JSON.stringify(kept[i]), 'utf8');
          const comma = i > 0 ? 1 : 0;
          if (total + comma + rowBytes > MAX_RESULT_BYTES) break;
          total += comma + rowBytes;
          fit += 1;
        }
        if (fit < kept.length) {
          kept = kept.slice(0, fit);
          truncated = true;
        }
      }
      return {
        rows: kept,
        rowCount: kept.length,
        truncated,
      };
    } finally {
      await qr.query('ROLLBACK').catch(() => undefined);
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
  const byTable = new Map<string, Array<{ name: string; type: string; nullable: boolean }>>();
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
