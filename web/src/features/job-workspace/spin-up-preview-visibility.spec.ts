import { describe, expect, it } from 'vitest';
import { shouldShowSpinUpPreview } from './spin-up-preview-visibility';

describe('shouldShowSpinUpPreview', () => {
  it('offers the button at the live ship gate before it is requested', () => {
    expect(shouldShowSpinUpPreview('awaiting_ship_review', undefined)).toBe(true);
    expect(shouldShowSpinUpPreview('awaiting_ship_review', null)).toBe(true);
  });

  it('hides the button once requested (card stamped previewRequestedAt)', () => {
    expect(shouldShowSpinUpPreview('awaiting_ship_review', '2026-07-11T00:00:00.000Z')).toBe(false);
  });

  it('hides the button on a shipped/historical transcript whose ship card still renders', () => {
    // The ship card is a durable row that keeps rendering after ship (status → done); gating on the live
    // status is what keeps the button off that stale transcript.
    expect(shouldShowSpinUpPreview('done', undefined)).toBe(false);
    expect(shouldShowSpinUpPreview('running', undefined)).toBe(false);
    expect(shouldShowSpinUpPreview('amending', undefined)).toBe(false);
  });

  it('hides the button when the live status is not yet known', () => {
    expect(shouldShowSpinUpPreview(undefined, undefined)).toBe(false);
    expect(shouldShowSpinUpPreview('no_job', undefined)).toBe(false);
  });
});
