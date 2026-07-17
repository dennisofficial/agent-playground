import { describe, expect, it } from 'vitest';
import { serviceStatus } from '../exposure/service-markers';
import type { ServiceLivenessProbe } from '../sandbox';

/**
 * Unit tests for the marker → live-status mapping — the load-bearing generation gate that keeps a
 * recreated container reusing an old pgid from faking `running`. See `serviceStatus`.
 */
describe('serviceStatus', () => {
  const T1 = '2026-07-02T10:00:00Z'; // a previous container generation
  const T2 = '2026-07-02T11:00:00.250Z'; // current container boot (sub-second, an hour later)
  const T3 = '2026-07-02T11:05:00Z'; // a service started AFTER the current boot

  const up = (alive: number[]): ServiceLivenessProbe => ({
    status: 'up',
    containerStartedAt: T2,
    alive,
  });

  it('probe unknown → unknown regardless of marker', () => {
    expect(serviceStatus({ pgid: 100, startedAt: T3 }, { status: 'unknown' })).toBe('unknown');
  });

  it('probe down → stopped (no running container ⇒ every marker is dead)', () => {
    expect(serviceStatus({ pgid: 100, startedAt: T3 }, { status: 'down' })).toBe('stopped');
  });

  it('current-generation marker whose pgid is alive → running', () => {
    expect(serviceStatus({ pgid: 100, startedAt: T3 }, up([100]))).toBe('running');
  });

  it('current-generation marker whose pgid is NOT alive → stopped (process died this generation)', () => {
    expect(serviceStatus({ pgid: 100, startedAt: T3 }, up([200]))).toBe('stopped');
  });

  it('REGRESSION: previous-generation marker with a REUSED live pgid → stopped, not running', () => {
    // The old service (started at T1, an hour before the current container booted) left a marker whose
    // pgid the fresh container happens to have reused — kill -0 answers, but it is NOT the same process.
    expect(serviceStatus({ pgid: 100, startedAt: T1 }, up([100]))).toBe('stopped');
  });

  it('same-second-as-boot start is NOT mis-gated as previous generation (skew tolerance)', () => {
    // atlas-svc writes second-precision timestamps; a service started ~same second as the sub-second
    // container boot can truncate just below it. Within the skew window it must still count as current.
    const sameSecond = '2026-07-02T11:00:00Z'; // truncates to .000, below the .250 boot — but < 2s under
    expect(serviceStatus({ pgid: 100, startedAt: sameSecond }, up([100]))).toBe('running');
  });

  it('null pgid → unknown (can not probe a groupless marker)', () => {
    expect(serviceStatus({ pgid: null, startedAt: T3 }, up([100]))).toBe('unknown');
  });

  it('null startedAt → unknown (can not verify the generation)', () => {
    expect(serviceStatus({ pgid: 100, startedAt: null }, up([100]))).toBe('unknown');
  });

  it('unparseable startedAt → unknown (never a false running)', () => {
    expect(serviceStatus({ pgid: 100, startedAt: 'not-a-date' }, up([100]))).toBe('unknown');
  });
});
