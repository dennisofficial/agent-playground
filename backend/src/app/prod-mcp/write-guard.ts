export function assertSingleWriteStatement(raw: string): string {
  const trimmed = raw.trim().replace(/;\s*$/, '');
  if (trimmed === '') throw new Error('sql is required');
  if (trimmed.includes(';')) throw new Error('multiple statements are not allowed');
  if (!/^(insert|update|delete|with)\b/i.test(trimmed))
    throw new Error('only single-statement INSERT/UPDATE/DELETE/WITH writes are allowed');
  return trimmed;
}
