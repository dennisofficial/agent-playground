import { CHAT_MODEL, formatUsageLine } from './usage-format';

/** Minimal valid AccumulatedUsage with all fields. */
function makeUsage(
  overrides: Partial<Parameters<typeof formatUsageLine>[0]> = {},
) {
  return {
    input: 1000,
    output: 80,
    cacheRead: 0,
    cacheWrite: 0,
    costUsd: 0.0042,
    callCount: 1,
    ...overrides,
  };
}

describe('formatUsageLine', () => {
  it('single-call turn: no model prefix, no call count', () => {
    const line = formatUsageLine(makeUsage({ callCount: 1 }), CHAT_MODEL);
    expect(line).not.toContain(CHAT_MODEL);
    expect(line).not.toContain('calls');
    expect(line).toMatch(/^in /);
  });

  it('single-call turn without model arg: no model prefix', () => {
    const line = formatUsageLine(makeUsage({ callCount: 1 }));
    expect(line).not.toContain(CHAT_MODEL);
    expect(line).not.toContain('calls');
  });

  it('multi-call turn: model name and call count precede token counts', () => {
    const line = formatUsageLine(makeUsage({ callCount: 5 }), CHAT_MODEL);
    expect(line).toContain('claude-sonnet-4-6');
    expect(line).toContain('5 calls');
    // model and call count come before "in …"
    expect(line.indexOf('claude-sonnet-4-6')).toBeLessThan(line.indexOf('in '));
    expect(line.indexOf('5 calls')).toBeLessThan(line.indexOf('in '));
    // token counts still present
    expect(line).toContain('in 1,000');
    expect(line).toContain('out 80');
  });

  it('multi-call turn without model arg: no prefix even with callCount > 1', () => {
    const line = formatUsageLine(makeUsage({ callCount: 5 }));
    expect(line).not.toContain('calls');
    expect(line).toMatch(/^in /);
  });

  it('callCount exactly 2: boundary — prefix shows', () => {
    const line = formatUsageLine(makeUsage({ callCount: 2 }), CHAT_MODEL);
    expect(line).toContain('2 calls');
    expect(line).toContain(CHAT_MODEL);
  });

  it('cache fields appear when non-zero, omitted when zero', () => {
    const withCache = formatUsageLine(
      makeUsage({ cacheRead: 300, cacheWrite: 50, callCount: 1 }),
    );
    expect(withCache).toContain('cache read 300');
    expect(withCache).toContain('cache write 50');

    const noCache = formatUsageLine(
      makeUsage({ cacheRead: 0, cacheWrite: 0, callCount: 1 }),
    );
    expect(noCache).not.toContain('cache read');
    expect(noCache).not.toContain('cache write');
  });

  it('cost is formatted to 4 decimal places', () => {
    const line = formatUsageLine(makeUsage({ costUsd: 0.12345678 }));
    expect(line).toContain('$0.1235');
  });

  it('large token counts are comma-formatted', () => {
    const line = formatUsageLine(
      makeUsage({ input: 1_234_567, output: 98_765 }),
    );
    expect(line).toContain('in 1,234,567');
    expect(line).toContain('out 98,765');
  });
});
