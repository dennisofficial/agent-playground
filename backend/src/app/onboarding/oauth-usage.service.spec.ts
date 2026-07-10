import { describe, expect, it } from 'vitest';
import { OauthUsageService } from './oauth-usage.service';
import type { CredentialResolver } from './credential-resolver.service';

/** applyHarvest is a pure in-memory fold; get() serves the harvested snapshot without HTTP when it's fresh. */
function makeService(): OauthUsageService {
  // No credential is needed: a fresh, non-empty harvest short-circuits the HTTP fallback in get().
  return new OauthUsageService({} as unknown as CredentialResolver);
}

describe('OauthUsageService.applyHarvest', () => {
  it('paints the session window full on a rejected frame that omits utilization + window', async () => {
    const svc = makeService();
    const resetsAt = Date.now() + 60 * 60 * 1000;
    svc.applyHarvest('org1', { status: 'rejected', resetsAt });

    const usage = await svc.get('org1');
    expect(usage.ok).toBe(true);
    expect(usage.source).toBe('harvested');
    expect(usage.fiveHour).toEqual({
      utilization: 100,
      resetsAt: new Date(resetsAt).toISOString(),
    });
  });

  it('paints the named window full on a rejected frame with a rateLimitType', async () => {
    const svc = makeService();
    const resetsAt = Date.now() + 60 * 60 * 1000;
    svc.applyHarvest('org1', {
      status: 'rejected',
      rateLimitType: 'seven_day',
      resetsAt,
    });

    const usage = await svc.get('org1');
    expect(usage.sevenDay).toEqual({
      utilization: 100,
      resetsAt: new Date(resetsAt).toISOString(),
    });
    expect(usage.fiveHour).toBeNull();
  });

  it('normalizes an epoch-SECONDS resetsAt from a harvested frame (not 1970)', async () => {
    const svc = makeService();
    const seconds = 1783650000; // epoch seconds → 2026
    svc.applyHarvest('org1', {
      status: 'rejected',
      rateLimitType: 'five_hour',
      resetsAt: seconds,
    });
    const usage = await svc.get('org1');
    expect(usage.fiveHour?.resetsAt).toBe(new Date(seconds * 1000).toISOString());
    expect(new Date(usage.fiveHour!.resetsAt).getUTCFullYear()).toBe(2026);
  });

  it('records a non-rejected frame at its reported utilization', async () => {
    const svc = makeService();
    const resetsAt = Date.now() + 60 * 60 * 1000;
    svc.applyHarvest('org1', {
      status: 'allowed_warning',
      rateLimitType: 'five_hour',
      utilization: 82,
      resetsAt,
    });

    const usage = await svc.get('org1');
    expect(usage.fiveHour?.utilization).toBe(82);
  });

  it('ignores a non-rejected frame with no utilization (nothing to record)', () => {
    const svc = makeService();
    // Must not throw and must not create a window from a bare allowed frame.
    expect(() =>
      svc.applyHarvest('org1', {
        status: 'allowed',
        rateLimitType: 'five_hour',
        resetsAt: Date.now(),
      }),
    ).not.toThrow();
  });

  it('ignores a frame with no resetsAt', () => {
    const svc = makeService();
    expect(() =>
      svc.applyHarvest('org1', { status: 'rejected', utilization: 100 }),
    ).not.toThrow();
  });
});
