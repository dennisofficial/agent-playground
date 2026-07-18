import { describe, expect, it } from 'vitest';
import { formatEffort } from './format';

describe('formatEffort', () => {
  it('maps known reasoning-effort values to friendly labels', () => {
    expect(formatEffort('minimal')).toBe('Minimal');
    expect(formatEffort('low')).toBe('Low');
    expect(formatEffort('medium')).toBe('Medium');
    expect(formatEffort('high')).toBe('High');
    expect(formatEffort('xhigh')).toBe('xHigh');
    expect(formatEffort('max')).toBe('Max');
  });

  it('is case-insensitive', () => {
    expect(formatEffort('HIGH')).toBe('High');
  });

  it('returns null when effort is unset', () => {
    expect(formatEffort(undefined)).toBeNull();
    expect(formatEffort('')).toBeNull();
  });

  it('falls back to the raw value for unknown efforts', () => {
    expect(formatEffort('bespoke')).toBe('bespoke');
  });
});
