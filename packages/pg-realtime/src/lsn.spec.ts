import { describe, expect, it } from 'vitest';
import { ZERO_LSN, lsnGt, lsnGte, parseLsn } from './lsn';

describe('parseLsn', () => {
  it('combines the high/low 32-bit halves into one bigint', () => {
    expect(parseLsn('0/00000000')).toBe(0n);
    expect(parseLsn('0/000000FF')).toBe(255n);
    expect(parseLsn('1/00000000')).toBe(1n << 32n);
    expect(parseLsn('1/00000001')).toBe((1n << 32n) | 1n);
  });

  it('parses a slash-less value as a bare hex number', () => {
    expect(parseLsn('FF')).toBe(255n);
    expect(parseLsn('00000000')).toBe(0n);
  });

  it('ZERO_LSN parses to zero', () => {
    expect(parseLsn(ZERO_LSN)).toBe(0n);
  });
});

describe('lsn comparison is numeric, not lexical', () => {
  it('orders by value even when lexical order disagrees', () => {
    // '10/0' < '9/0' lexically, but 0x10_00000000 > 0x9_00000000 numerically.
    expect(lsnGt('10/0', '9/0')).toBe(true);
    expect(lsnGt('9/0', '10/0')).toBe(false);
  });

  it('lsnGt is strict', () => {
    expect(lsnGt('0/10', '0/10')).toBe(false);
    expect(lsnGt('0/11', '0/10')).toBe(true);
  });

  it('lsnGte is inclusive', () => {
    expect(lsnGte('0/10', '0/10')).toBe(true);
    expect(lsnGte('0/0F', '0/10')).toBe(false);
    expect(lsnGte('0/11', '0/10')).toBe(true);
  });

  it('compares across the high-half boundary', () => {
    expect(lsnGt('1/00000000', '0/FFFFFFFF')).toBe(true);
    expect(lsnGte('0/FFFFFFFF', '1/00000000')).toBe(false);
  });
});
