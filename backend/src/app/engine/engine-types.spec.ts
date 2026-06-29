import { describe, expect, it } from 'vitest';
import { DEFAULT_CONTEXT_LIMIT, resolveContextLimit } from './engine.types';

describe('resolveContextLimit', () => {
  it('maps Opus and Sonnet model ids to the 1M window', () => {
    expect(resolveContextLimit('claude-opus-4-8')).toBe(1_000_000);
    expect(resolveContextLimit('opus')).toBe(1_000_000);
    expect(resolveContextLimit('claude-sonnet-4-6')).toBe(1_000_000);
  });

  it('maps Haiku to the 200k window', () => {
    expect(resolveContextLimit('claude-haiku-4-5-20251001')).toBe(200_000);
  });

  it('is case-insensitive', () => {
    expect(resolveContextLimit('Claude-OPUS-4-8')).toBe(1_000_000);
  });

  it('falls back to the default window for unknown/absent model ids', () => {
    expect(resolveContextLimit('gpt-5')).toBe(DEFAULT_CONTEXT_LIMIT);
    expect(resolveContextLimit(undefined)).toBe(DEFAULT_CONTEXT_LIMIT);
    expect(resolveContextLimit('')).toBe(DEFAULT_CONTEXT_LIMIT);
  });
});
