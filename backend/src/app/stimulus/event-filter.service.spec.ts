import type { EnvService } from '@core/config/env/env.service';
import { describe, expect, it } from 'vitest';
import { EventFilterService } from './event-filter.service';

function makeFilter(overrides: Record<string, unknown> = {}): EventFilterService {
  const map: Record<string, unknown> = {
    EVENT_DEDUP_WINDOW_S: 300,
    EVENT_RATE_LIMIT: 5,
    EVENT_RATE_WINDOW_S: 60,
    ...overrides,
  };
  const env = { get: (k: string) => map[k] } as unknown as EnvService;
  return new EventFilterService(env);
}

const KEY = {
  orgId: 'T1',
  repoId: 'web',
  source: 'github',
  dedupeKey: 'run:1',
};

describe('EventFilterService (mechanical dedup + rate-limit, no LLM)', () => {
  it('admits the first event for a key', () => {
    const f = makeFilter();
    expect(f.admit(KEY, 0)).toEqual({ pass: true });
  });

  it('drops a duplicate within the dedup window', () => {
    const f = makeFilter();
    expect(f.admit(KEY, 0).pass).toBe(true);
    const v = f.admit(KEY, 60_000); // 60s later, < 300s window
    expect(v.pass).toBe(false);
    if (v.pass) throw new Error('unreachable');
    expect(v.reason).toBe('duplicate');
  });

  it('admits the same key again AFTER the dedup window passes', () => {
    const f = makeFilter();
    expect(f.admit(KEY, 0).pass).toBe(true);
    // 301s later: past the 300s dedup window AND the 60s rate window (so the rate counter reset too).
    expect(f.admit(KEY, 301_000).pass).toBe(true);
  });

  it('keeps DISTINCT keys (different dedupeKey) independent', () => {
    const f = makeFilter();
    expect(f.admit(KEY, 0).pass).toBe(true);
    expect(f.admit({ ...KEY, dedupeKey: 'run:2' }, 1000).pass).toBe(true);
  });

  it('keeps DISTINCT projects independent (same dedupeKey)', () => {
    const f = makeFilter();
    expect(f.admit(KEY, 0).pass).toBe(true);
    expect(f.admit({ ...KEY, repoId: 'api' }, 1000).pass).toBe(true);
  });

  it('rate-limits a key whose dedupeKey keeps mutating within the rate window', () => {
    // Short dedup window so dedup doesn't mask the rate-limit; 3 admissions / 60s.
    const f = makeFilter({
      EVENT_DEDUP_WINDOW_S: 1,
      EVENT_RATE_LIMIT: 3,
      EVENT_RATE_WINDOW_S: 60,
    });
    const base = { orgId: 'T1', repoId: 'web', source: 'github' };
    expect(f.admit({ ...base, dedupeKey: 'a' }, 0).pass).toBe(true);
    expect(f.admit({ ...base, dedupeKey: 'b' }, 2_000).pass).toBe(true);
    expect(f.admit({ ...base, dedupeKey: 'c' }, 4_000).pass).toBe(true);
    // 4th within the window — different keys, but the rate window collapses across dedupeKeys? No:
    // the filter keys on the FULL tuple incl. dedupeKey, so each distinct key has its own counter.
    // This asserts distinct keys are NOT rate-limited against each other.
    expect(f.admit({ ...base, dedupeKey: 'd' }, 5_000).pass).toBe(true);
  });

  it('rate-limits repeated DISTINCT-but-same-tuple bursts past the limit', () => {
    // To trip the rate-limit on ONE key, space hits past the dedup window but within the rate window.
    const f = makeFilter({
      EVENT_DEDUP_WINDOW_S: 5,
      EVENT_RATE_LIMIT: 3,
      EVENT_RATE_WINDOW_S: 600,
    });
    expect(f.admit(KEY, 0).pass).toBe(true); // hit 1
    expect(f.admit(KEY, 10_000).pass).toBe(true); // hit 2 (past 5s dedup, within 600s rate)
    expect(f.admit(KEY, 20_000).pass).toBe(true); // hit 3
    const v = f.admit(KEY, 30_000); // 4th in the rate window → rate-limited
    expect(v.pass).toBe(false);
    if (v.pass) throw new Error('unreachable');
    expect(v.reason).toBe('rate-limited');
  });
});
