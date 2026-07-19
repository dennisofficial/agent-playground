import { describe, expect, it } from 'vitest';
import { cardSendState, messageSendState } from '../lib/send-state';

describe('messageSendState', () => {
  it('is sending while local (optimistic, pre-server-echo)', () => {
    expect(messageSendState({ local: true })).toBe('sending');
  });

  it('is landed for a legacy/non-operator row with neither stimulusId nor deliveredAt', () => {
    expect(messageSendState({})).toBe('landed');
  });

  it('is sending while a stimulusId exists but deliveredAt is not yet stamped', () => {
    expect(messageSendState({ stimulusId: 'stim-1' })).toBe('sending');
  });

  it('is landed once deliveredAt is stamped', () => {
    expect(
      messageSendState({
        stimulusId: 'stim-1',
        deliveredAt: '2026-07-16T00:00:00.000Z',
      }),
    ).toBe('landed');
  });

  it('local takes precedence even if stimulusId/deliveredAt are somehow both present', () => {
    expect(
      messageSendState({
        local: true,
        stimulusId: 'stim-1',
        deliveredAt: '2026-07-16T00:00:00.000Z',
      }),
    ).toBe('sending');
  });
});

describe('cardSendState', () => {
  it("is staged when there's no answer yet", () => {
    expect(cardSendState(false, undefined)).toBe('staged');
    expect(cardSendState(false, null)).toBe('staged');
  });

  it('is sending once answered but not yet delivered', () => {
    expect(cardSendState(true, undefined)).toBe('sending');
    expect(cardSendState(true, null)).toBe('sending');
  });

  it('is landed once answered and delivered', () => {
    expect(cardSendState(true, '2026-07-16T00:00:00.000Z')).toBe('landed');
  });
});
