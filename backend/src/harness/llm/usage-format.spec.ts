import {
  CHAT_MODEL,
  extractMessageUsage,
  formatUsageLine,
} from './usage-format';

/** Minimal valid AccumulatedUsage with all fields. */
function makeUsage(
  overrides: Partial<Parameters<typeof formatUsageLine>[0]> = {},
) {
  return {
    input: 1000,
    output: 80,
    cacheRead: 0,
    cacheWrite5m: 0,
    cacheWrite1h: 0,
    costUsd: 0.0042,
    callCount: 1,
    ...overrides,
  };
}

describe('formatUsageLine', () => {
  it('single-call turn: model prefix shows, but no call count', () => {
    const line = formatUsageLine(makeUsage({ callCount: 1 }), CHAT_MODEL);
    expect(line).toContain(CHAT_MODEL);
    expect(line).not.toContain('calls');
    // model precedes the token counts
    expect(line.indexOf(CHAT_MODEL)).toBeLessThan(line.indexOf('in '));
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

  it('multi-call turn without model arg: call count shows, no model prefix', () => {
    const line = formatUsageLine(makeUsage({ callCount: 5 }));
    expect(line).not.toContain(CHAT_MODEL);
    expect(line).toContain('5 calls');
    // line leads with the call count, then the token counts
    expect(line.indexOf('5 calls')).toBeLessThan(line.indexOf('in '));
  });

  it('callCount exactly 2: boundary — prefix shows', () => {
    const line = formatUsageLine(makeUsage({ callCount: 2 }), CHAT_MODEL);
    expect(line).toContain('2 calls');
    expect(line).toContain(CHAT_MODEL);
  });

  it('cache fields appear when non-zero, omitted when zero', () => {
    const withCache = formatUsageLine(
      makeUsage({ cacheRead: 300, cacheWrite5m: 20, cacheWrite1h: 30, callCount: 1 }),
    );
    expect(withCache).toContain('cache read 300');
    expect(withCache).toContain('cache write 5m 20');
    expect(withCache).toContain('cache write 1h 30');

    const noCache = formatUsageLine(
      makeUsage({ cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0, callCount: 1 }),
    );
    expect(noCache).not.toContain('cache read');
    expect(noCache).not.toContain('cache write');
  });

  it('only cacheWrite5m non-zero: shows 5m label, omits 1h', () => {
    const line = formatUsageLine(makeUsage({ cacheWrite5m: 50, cacheWrite1h: 0 }));
    expect(line).toContain('cache write 5m 50');
    expect(line).not.toContain('cache write 1h');
  });

  it('only cacheWrite1h non-zero: shows 1h label, omits 5m', () => {
    const line = formatUsageLine(makeUsage({ cacheWrite5m: 0, cacheWrite1h: 80 }));
    expect(line).toContain('cache write 1h 80');
    expect(line).not.toContain('cache write 5m');
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

describe('extractMessageUsage', () => {
  it('returns undefined when usage_metadata is absent', () => {
    expect(extractMessageUsage({} as never)).toBeUndefined();
  });

  it('extracts basic input/output/cacheRead from usage_metadata', () => {
    const msg = {
      usage_metadata: {
        input_tokens: 1000,
        output_tokens: 80,
        input_token_details: { cache_read: 400 },
      },
    } as never;
    const result = extractMessageUsage(msg)!;
    expect(result.input).toBe(1000);
    expect(result.output).toBe(80);
    expect(result.cacheRead).toBe(400);
    expect(result.cacheWrite5m).toBeUndefined();
    expect(result.cacheWrite1h).toBeUndefined();
  });

  it('falls back to input_token_details.cache_creation as cacheWrite1h when response_metadata absent', () => {
    const msg = {
      usage_metadata: {
        input_tokens: 1000,
        output_tokens: 80,
        input_token_details: { cache_creation: 200 },
      },
    } as never;
    const result = extractMessageUsage(msg)!;
    expect(result.cacheWrite1h).toBe(200);
    expect(result.cacheWrite5m).toBeUndefined();
  });

  it('extracts TTL-split cache_creation object from response_metadata', () => {
    const msg = {
      usage_metadata: {
        input_tokens: 1000,
        output_tokens: 80,
        input_token_details: {},
      },
      response_metadata: {
        usage: { cache_creation: { '5m': 300, '1h': 700 } },
      },
    } as never;
    const result = extractMessageUsage(msg)!;
    expect(result.cacheWrite5m).toBe(300);
    expect(result.cacheWrite1h).toBe(700);
  });

  it('treats zero TTL buckets as undefined (omits them)', () => {
    const msg = {
      usage_metadata: { input_tokens: 500, output_tokens: 40, input_token_details: {} },
      response_metadata: {
        usage: { cache_creation: { '5m': 0, '1h': 500 } },
      },
    } as never;
    const result = extractMessageUsage(msg)!;
    expect(result.cacheWrite5m).toBeUndefined();
    expect(result.cacheWrite1h).toBe(500);
  });

  it('also checks cache_creation_input_tokens key (Anthropic SDK field name)', () => {
    const msg = {
      usage_metadata: { input_tokens: 500, output_tokens: 40, input_token_details: {} },
      response_metadata: {
        usage: { cache_creation_input_tokens: { '5m': 100, '1h': 200 } },
      },
    } as never;
    const result = extractMessageUsage(msg)!;
    expect(result.cacheWrite5m).toBe(100);
    expect(result.cacheWrite1h).toBe(200);
  });
});
