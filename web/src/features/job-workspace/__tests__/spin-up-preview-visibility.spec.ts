import { EJobStatus } from '@workspace/shared';
import { describe, expect, it } from 'vitest';
import { shouldShowSpinUpPreview } from '../lib/spin-up-preview-visibility';

describe('shouldShowSpinUpPreview', () => {
  it('offers the button at the live ship gate before it is requested', () => {
    expect(shouldShowSpinUpPreview(EJobStatus.AWAITING_SHIP_REVIEW, undefined)).toBe(true);
    expect(shouldShowSpinUpPreview(EJobStatus.AWAITING_SHIP_REVIEW, null)).toBe(true);
  });

  it('hides the button once requested (card stamped previewRequestedAt)', () => {
    expect(
      shouldShowSpinUpPreview(EJobStatus.AWAITING_SHIP_REVIEW, '2026-07-11T00:00:00.000Z'),
    ).toBe(false);
  });

  it('hides the button on a shipped/historical transcript whose ship card still renders', () => {
    // The ship card is a durable row that keeps rendering after ship (status → done); gating on the live
    // status is what keeps the button off that stale transcript.
    expect(shouldShowSpinUpPreview(EJobStatus.DONE, undefined)).toBe(false);
    expect(shouldShowSpinUpPreview(EJobStatus.RUNNING, undefined)).toBe(false);
    expect(shouldShowSpinUpPreview(EJobStatus.AMENDING, undefined)).toBe(false);
  });

  it('hides the button when the live status is not yet known', () => {
    expect(shouldShowSpinUpPreview(undefined, undefined)).toBe(false);
    expect(shouldShowSpinUpPreview('no_job', undefined)).toBe(false);
  });
});
