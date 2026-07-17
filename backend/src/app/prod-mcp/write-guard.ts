/**
 * App-layer guard for `propose_prod_write`: accept only a single INSERT/UPDATE/DELETE/WITH statement.
 * Sibling of `./query.ts`'s `assertReadOnlySelect` — same trim/strip/reject shape, mirrored for
 * writes. Layered on top of the structural DML-only `mcp_writer` DB role (d4): even if this guard were
 * bypassed, the role itself cannot run DDL/GRANT.
 *
 * Accepted tradeoff (trusted users): a ';' inside a string literal (e.g. `UPDATE x SET s=';'`) is
 * rejected. The DML-only role is the real structural block regardless.
 */
export function assertSingleWriteStatement(raw: string): string {
  const trimmed = raw.trim().replace(/;\s*$/, '');
  if (trimmed === '') throw new Error('sql is required');
  if (trimmed.includes(';')) throw new Error('multiple statements are not allowed');
  if (!/^(insert|update|delete|with)\b/i.test(trimmed))
    throw new Error('only single-statement INSERT/UPDATE/DELETE/WITH writes are allowed');
  return trimmed;
}
