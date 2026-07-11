import { describe, expect, it } from 'vitest';
import { assertReadOnlySelect } from './query';

describe('assertReadOnlySelect', () => {
  it('accepts a plain SELECT', () => {
    expect(assertReadOnlySelect('SELECT 1')).toBe('SELECT 1');
  });

  it('accepts a lowercase select', () => {
    expect(assertReadOnlySelect('select id from jobs')).toBe(
      'select id from jobs',
    );
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
