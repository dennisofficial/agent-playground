import { describe, expect, it } from 'vitest';
import { assertSingleWriteStatement } from './write-guard';

describe('assertSingleWriteStatement', () => {
  it('accepts a plain INSERT', () => {
    expect(assertSingleWriteStatement('INSERT INTO x VALUES (1)')).toBe('INSERT INTO x VALUES (1)');
  });

  it('accepts a plain UPDATE', () => {
    expect(assertSingleWriteStatement('UPDATE x SET a=1')).toBe('UPDATE x SET a=1');
  });

  it('accepts a plain DELETE', () => {
    expect(assertSingleWriteStatement('DELETE FROM x WHERE id=1')).toBe('DELETE FROM x WHERE id=1');
  });

  it('accepts a WITH ... UPDATE statement', () => {
    const sql = 'WITH t AS (SELECT id FROM x) UPDATE x SET a=1 WHERE id IN (SELECT id FROM t)';
    expect(assertSingleWriteStatement(sql)).toBe(sql);
  });

  it('accepts a lowercase update', () => {
    expect(assertSingleWriteStatement('update x set a=1')).toBe('update x set a=1');
  });

  it('strips one trailing semicolon', () => {
    expect(assertSingleWriteStatement('UPDATE x SET a=1;')).toBe('UPDATE x SET a=1');
  });

  it('rejects an empty string', () => {
    expect(() => assertSingleWriteStatement('')).toThrow('sql is required');
  });

  it('rejects a whitespace-only string', () => {
    expect(() => assertSingleWriteStatement('   ')).toThrow('sql is required');
  });

  it('rejects a SELECT', () => {
    expect(() => assertSingleWriteStatement('SELECT 1')).toThrow(
      'only single-statement INSERT/UPDATE/DELETE/WITH writes are allowed',
    );
  });

  it.each(['DROP TABLE x', 'CREATE TABLE x (id int)', 'ALTER TABLE x ADD COLUMN y int'])(
    'rejects %s',
    (sql) => {
      expect(() => assertSingleWriteStatement(sql)).toThrow(
        'only single-statement INSERT/UPDATE/DELETE/WITH writes are allowed',
      );
    },
  );

  it('rejects GRANT', () => {
    expect(() => assertSingleWriteStatement('GRANT ALL ON x TO y')).toThrow(
      'only single-statement INSERT/UPDATE/DELETE/WITH writes are allowed',
    );
  });

  it('rejects a multi-statement write', () => {
    expect(() => assertSingleWriteStatement('update a set x=1; update b set x=1')).toThrow(
      'multiple statements are not allowed',
    );
  });
});
