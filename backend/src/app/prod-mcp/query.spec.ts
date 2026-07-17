import type { DataSource } from 'typeorm';
import { describe, expect, it, vi } from 'vitest';
import { assertReadOnlySelect, MAX_RESULT_BYTES, runReadOnlyQuery } from './query';

describe('assertReadOnlySelect', () => {
  it('accepts a plain SELECT', () => {
    expect(assertReadOnlySelect('SELECT 1')).toBe('SELECT 1');
  });

  it('accepts a lowercase select', () => {
    expect(assertReadOnlySelect('select id from jobs')).toBe('select id from jobs');
  });

  it('strips one trailing semicolon', () => {
    expect(assertReadOnlySelect('SELECT 1;')).toBe('SELECT 1');
  });

  it('accepts a WITH ... SELECT statement', () => {
    const sql = 'WITH t AS (SELECT 1) SELECT * FROM t';
    expect(assertReadOnlySelect(sql)).toBe(sql);
  });

  it('rejects an empty string', () => {
    expect(() => assertReadOnlySelect('')).toThrow('sql is required');
  });

  it('rejects a whitespace-only string', () => {
    expect(() => assertReadOnlySelect('   ')).toThrow('sql is required');
  });

  it.each([
    'INSERT INTO x VALUES (1)',
    'UPDATE x SET a=1',
    'DELETE FROM x',
    'DROP TABLE x',
    'ALTER TABLE x',
    'TRUNCATE x',
  ])('rejects %s', (sql) => {
    expect(() => assertReadOnlySelect(sql)).toThrow(
      'only single read-only SELECT/WITH queries are allowed',
    );
  });

  it('rejects a multi-statement query', () => {
    expect(() => assertReadOnlySelect('SELECT 1; DROP TABLE x')).toThrow(
      'multiple statements are not allowed',
    );
  });
});

describe('runReadOnlyQuery', () => {
  it('rolls back, discards session state, and releases the query runner after success', async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.startsWith('SELECT * FROM')) return [{ value: 1 }];
      return [];
    });
    const release = vi.fn();
    const ds = {
      createQueryRunner: () => ({
        connect: vi.fn(),
        query,
        release,
      }),
    } as unknown as DataSource;

    await expect(runReadOnlyQuery(ds, 'SELECT 1 AS value', [])).resolves.toEqual({
      rows: [{ value: 1 }],
      rowCount: 1,
      truncated: false,
    });
    expect(query.mock.calls.map(([sql]) => sql)).toEqual([
      'START TRANSACTION READ ONLY',
      "SET LOCAL statement_timeout = '10s'",
      'SELECT * FROM (\nSELECT 1 AS value\n) AS __atlas_q LIMIT 1001',
      'ROLLBACK',
      'DISCARD ALL',
    ]);
    expect(release).toHaveBeenCalledOnce();
  });

  it('rolls back, discards session state, and releases the query runner after query failure', async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.startsWith('SELECT * FROM')) throw new Error('query failed');
      return [];
    });
    const release = vi.fn();
    const ds = {
      createQueryRunner: () => ({
        connect: vi.fn(),
        query,
        release,
      }),
    } as unknown as DataSource;

    await expect(runReadOnlyQuery(ds, 'SELECT 1', [])).rejects.toThrow('query failed');
    expect(query.mock.calls.map(([sql]) => sql)).toEqual([
      'START TRANSACTION READ ONLY',
      "SET LOCAL statement_timeout = '10s'",
      'SELECT * FROM (\nSELECT 1\n) AS __atlas_q LIMIT 1001',
      'ROLLBACK',
      'DISCARD ALL',
    ]);
    expect(release).toHaveBeenCalledOnce();
  });

  it('uses an explicit limit to compute the wrapped LIMIT', async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.startsWith('SELECT * FROM')) return [{ value: 1 }];
      return [];
    });
    const ds = {
      createQueryRunner: () => ({
        connect: vi.fn(),
        query,
        release: vi.fn(),
      }),
    } as unknown as DataSource;

    await runReadOnlyQuery(ds, 'SELECT 1 AS value', [], 5);
    expect(query.mock.calls.map(([sql]) => sql)).toContain(
      'SELECT * FROM (\nSELECT 1 AS value\n) AS __atlas_q LIMIT 6',
    );
  });

  it('clamps a limit above the hard ceiling', async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.startsWith('SELECT * FROM')) return [{ value: 1 }];
      return [];
    });
    const ds = {
      createQueryRunner: () => ({
        connect: vi.fn(),
        query,
        release: vi.fn(),
      }),
    } as unknown as DataSource;

    await runReadOnlyQuery(ds, 'SELECT 1 AS value', [], 999999);
    expect(query.mock.calls.map(([sql]) => sql)).toContain(
      'SELECT * FROM (\nSELECT 1 AS value\n) AS __atlas_q LIMIT 50001',
    );
  });

  it('rejects a non-finite limit before building SQL', async () => {
    const ds = {
      createQueryRunner: vi.fn(),
    } as unknown as DataSource;

    await expect(runReadOnlyQuery(ds, 'SELECT 1 AS value', [], Number.NaN)).rejects.toThrow(
      'limit must be a finite number',
    );
  });

  it('truncates and reports rowCount/rows at the effective limit when the driver returns one extra row', async () => {
    const effective = 5;
    const query = vi.fn(async (sql: string) => {
      if (sql.startsWith('SELECT * FROM')) {
        return Array.from({ length: effective + 1 }, (_, i) => ({ value: i }));
      }
      return [];
    });
    const ds = {
      createQueryRunner: () => ({
        connect: vi.fn(),
        query,
        release: vi.fn(),
      }),
    } as unknown as DataSource;

    const result = await runReadOnlyQuery(ds, 'SELECT 1 AS value', [], effective);
    expect(result.truncated).toBe(true);
    expect(result.rowCount).toBe(effective);
    expect(result.rows).toHaveLength(effective);
  });

  it('does not return a single row that exceeds the byte cap by itself', async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.startsWith('SELECT * FROM')) {
        return [{ note: 'x'.repeat(MAX_RESULT_BYTES) }];
      }
      return [];
    });
    const ds = {
      createQueryRunner: () => ({
        connect: vi.fn(),
        query,
        release: vi.fn(),
      }),
    } as unknown as DataSource;

    const result = await runReadOnlyQuery(ds, 'SELECT note FROM logs', [], 10);
    expect(result.truncated).toBe(true);
    expect(result.rowCount).toBe(0);
    expect(result.rows).toEqual([]);
  });
});
