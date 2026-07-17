import { describe, expect, it } from 'vitest';
import { THREAD_TYPES, coerceThreadType } from './thread-types';

describe('coerceThreadType', () => {
  it('passes every valid THREAD_TYPES value through unchanged', () => {
    for (const t of THREAD_TYPES) {
      expect(coerceThreadType(t)).toBe(t);
    }
  });

  it('is case-insensitive and trims surrounding whitespace', () => {
    expect(coerceThreadType('BACKEND')).toBe('backend');
    expect(coerceThreadType('  Data  ')).toBe('data');
    expect(coerceThreadType('Frontend')).toBe('frontend');
  });

  it("coerces the dropped 'analytics' label to 'general'", () => {
    expect(coerceThreadType('analytics')).toBe('general');
  });

  it("coerces unknown labels, empty strings, and nullish values to 'general'", () => {
    expect(coerceThreadType('server')).toBe('general');
    expect(coerceThreadType('')).toBe('general');
    expect(coerceThreadType('   ')).toBe('general');
    expect(coerceThreadType(undefined)).toBe('general');
    expect(coerceThreadType(null)).toBe('general');
    expect(coerceThreadType(42)).toBe('general');
  });
});
