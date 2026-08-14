import { describe, expect, it } from 'bun:test';
import { fastModeNotice } from '../fast-mode.js';

describe('fastModeNotice', () => {
  it('says nothing when fast mode is working — the speed is its own evidence', () => {
    expect(fastModeNotice({ state: 'on' })).toBeNull();
  });

  it('translates the codes a human cannot act on', () => {
    // The reported one. `preference` is not the USER's preference — it is the organisation's, and
    // printing the code said neither.
    expect(fastModeNotice({ state: 'off', disabledReason: 'preference' })).toBe(
      'fast mode disabled by your organization',
    );
    expect(fastModeNotice({ state: 'off', disabledReason: 'extra_usage_disabled' })).toBe(
      'fast mode requires usage credits',
    );
  });

  it('distinguishes a pause from a refusal', () => {
    expect(fastModeNotice({ state: 'cooldown' })).toBe(
      'fast mode paused until the rate limit clears',
    );
  });

  it('shows an unrecognised code rather than swallowing it', () => {
    expect(fastModeNotice({ state: 'off', disabledReason: 'brand_new_reason' })).toBe(
      'fast mode unavailable · brand_new_reason',
    );
    expect(fastModeNotice({ state: 'off' })).toBe('fast mode currently unavailable');
  });
});
