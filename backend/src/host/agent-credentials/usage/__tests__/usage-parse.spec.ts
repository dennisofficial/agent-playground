import { UsageParseService } from '../usage-parse.service';

const usageParse = new UsageParseService();
const parseModelWindows = (root: Record<string, unknown>) => usageParse.parseModelWindows(root);
const parseUsageResponse = (body: unknown) => usageParse.parseUsageResponse(body);
const resetEpochToIso = (n: number | undefined | null) => usageParse.resetEpochToIso(n);
const toPercentUtilization = (n: number | undefined) => usageParse.toPercentUtilization(n);

describe('toPercentUtilization', () => {
  it('scales a 0–1 fraction to a 0–100 percent', () => {
    expect(toPercentUtilization(0.42)).toBe(42);
  });
  it('passes through a 0–100 value and clamps', () => {
    expect(toPercentUtilization(73)).toBe(73);
    expect(toPercentUtilization(140)).toBe(100);
    expect(toPercentUtilization(-5)).toBe(0);
  });
  it('returns undefined for nullish', () => {
    expect(toPercentUtilization(undefined)).toBeUndefined();
  });
});

describe('resetEpochToIso', () => {
  it('treats sub-1e12 values as seconds', () => {
    expect(resetEpochToIso(1_700_000_000)).toBe(new Date(1_700_000_000_000).toISOString());
  });
  it('treats large values as milliseconds', () => {
    expect(resetEpochToIso(1_700_000_000_000)).toBe(new Date(1_700_000_000_000).toISOString());
  });
  it('returns undefined for null/invalid', () => {
    expect(resetEpochToIso(null)).toBeUndefined();
    expect(resetEpochToIso(undefined)).toBeUndefined();
  });
});

describe('parseUsageResponse', () => {
  it('reads flat windows and normalizes utilization + reset', () => {
    const iso = new Date(Date.now() + 3_600_000).toISOString();
    const parsed = parseUsageResponse({
      five_hour: { utilization: 55, resets_at: iso },
      seven_day: { utilization: 12, resets_at: iso },
    });
    expect(parsed.windows.fiveHour).toEqual({ utilization: 55, resetsAt: iso });
    expect(parsed.windows.sevenDay).toEqual({ utilization: 12, resetsAt: iso });
    expect(parsed.windows.sevenDayOpus).toBeUndefined();
  });

  it('reads windows nested under `rate_limits`', () => {
    const iso = new Date().toISOString();
    const parsed = parseUsageResponse({
      rate_limits: { five_hour: { utilization: 9, resets_at: iso } },
    });
    expect(parsed.windows.fiveHour).toEqual({ utilization: 9, resetsAt: iso });
  });

  it('drops a window with no valid reset', () => {
    const parsed = parseUsageResponse({ five_hour: { utilization: 55 } });
    expect(parsed.windows.fiveHour).toBeUndefined();
  });
});

describe('parseModelWindows', () => {
  it('keeps only weekly_scoped entries with a model display name', () => {
    const out = parseModelWindows({
      limits: [
        {
          kind: 'weekly_scoped',
          percent: 30,
          resets_at: '2026-07-20T00:00:00Z',
          scope: { model: { display_name: 'Fable' } },
        },
        { kind: 'five_hour', percent: 10 },
        { kind: 'weekly_scoped', percent: 5, scope: {} },
      ],
    });
    expect(out).toEqual([{ label: 'Fable', utilization: 30, resetsAt: '2026-07-20T00:00:00Z' }]);
  });
});

describe('windowKeyFor', () => {
  it('maps the four Anthropic rate-limit types', () => {
    expect(usageParse.windowKeyFor('five_hour')).toBe('fiveHour');
    expect(usageParse.windowKeyFor('seven_day_opus')).toBe('sevenDayOpus');
  });
  it('returns undefined for unknown/absent types', () => {
    expect(usageParse.windowKeyFor('nope')).toBeUndefined();
    expect(usageParse.windowKeyFor(undefined)).toBeUndefined();
  });
});
