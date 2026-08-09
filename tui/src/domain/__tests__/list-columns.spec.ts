import { describe, expect, it } from 'bun:test';
import { affords, elasticColumn, fitColumn, fitColumnEnd } from '../list-columns.js';

describe('fitColumn', () => {
  it('pads short values to exactly the column width', () => {
    expect(fitColumn('max20', 10)).toBe('max20     ');
  });

  it('clips long ones to exactly the column width', () => {
    const fitted = fitColumn('a-very-long-address@example.com', 12);
    expect(fitted).toBe('a-very-lon… ');
    expect([...fitted]).toHaveLength(12);
  });

  it('never lets a value fill its column — the next one would touch it', () => {
    expect(fitColumn('123456789012', 12)).toBe('1234567890… ');
    expect(fitColumn('12345678901', 12)).toBe('12345678901 ');
  });

  it('measures in code points, not UTF-16 units', () => {
    expect([...fitColumn('⚠⚠', 4)]).toHaveLength(4);
  });

  it('degrades rather than overflowing when there is no room at all', () => {
    expect(fitColumn('anything', 1)).toBe('…');
    expect(fitColumn('anything', 0)).toBe('');
  });
});

describe('fitColumnEnd', () => {
  it('keeps the end, which is the part a path is identified by', () => {
    expect(fitColumnEnd('~/Developer/work/atlas', 12)).toBe('…work/atlas ');
  });

  it('pads like any other column when the value fits', () => {
    expect(fitColumnEnd('~/dev', 8)).toBe('~/dev   ');
  });

  it('comes back at exactly the width asked for', () => {
    expect([...fitColumnEnd('/a/very/long/path/indeed', 9)]).toHaveLength(9);
  });
});

describe('elasticColumn', () => {
  it('hands the elastic column whatever the fixed ones did not take', () => {
    expect(elasticColumn(80, 30, { min: 10, max: 60 })).toBe(50);
  });

  it('stops growing where more width stops being information', () => {
    expect(elasticColumn(300, 30, { min: 10, max: 60 })).toBe(60);
  });

  it('never goes below its minimum — a row is allowed to overflow before it becomes unreadable', () => {
    expect(elasticColumn(20, 30, { min: 10, max: 60 })).toBe(10);
  });
});

describe('affords', () => {
  it('answers whether a form leaves the elastic column its minimum', () => {
    expect(affords(80, 60, 20)).toBe(true);
    expect(affords(80, 61, 20)).toBe(false);
  });
});
