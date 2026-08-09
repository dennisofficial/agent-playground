import { describe, expect, it } from 'bun:test';
import { clampIndex, matchesQuery } from '../list-nav.js';

describe('clampIndex', () => {
  it('leaves an in-range index alone', () => {
    expect(clampIndex(2, 5)).toBe(2);
  });

  it('pulls a cursor back onto the last row when the list shrinks under it', () => {
    expect(clampIndex(7, 3)).toBe(2);
  });

  it('never goes negative', () => {
    expect(clampIndex(-1, 3)).toBe(0);
  });

  it('is zero for an empty list — there is no row to point at', () => {
    expect(clampIndex(4, 0)).toBe(0);
  });
});

describe('matchesQuery', () => {
  it('matches everything when the query is empty or blank', () => {
    expect(matchesQuery('', 'atlas')).toBe(true);
    expect(matchesQuery('   ', 'atlas')).toBe(true);
  });

  it('is case-insensitive and matches anywhere in the field', () => {
    expect(matchesQuery('STEER', 'fix steering')).toBe(true);
  });

  it('matches if ANY field matches', () => {
    expect(matchesQuery('developer', 'atlas', '~/Developer/atlas')).toBe(true);
  });

  it('tolerates null and undefined fields', () => {
    expect(matchesQuery('x', null, undefined)).toBe(false);
  });

  it('rejects a non-match', () => {
    expect(matchesQuery('pgbase', 'atlas', '~/Developer/atlas')).toBe(false);
  });
});
