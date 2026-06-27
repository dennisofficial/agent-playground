import { describe, expect, it } from 'vitest';
import { deriveNeedsYou } from './thread';

/**
 * `deriveNeedsYou` is the single server-owned definition of the sidebar "alert dot": a thread needs the
 * operator when the AI is NOT actively working (no live turn, no running build) and is NOT terminal.
 */
describe('deriveNeedsYou', () => {
  it('is false while a conversational turn is streaming, regardless of status', () => {
    for (const status of ['open', 'scoping', 'awaiting_approval', 'running', 'paused', 'failed']) {
      expect(deriveNeedsYou(status, true)).toBe(false);
    }
  });

  it('is false when the build is running (AI working)', () => {
    expect(deriveNeedsYou('running', false)).toBe(false);
  });

  it('is false for terminal states (done / cancelled)', () => {
    expect(deriveNeedsYou('done', false)).toBe(false);
    expect(deriveNeedsYou('cancelled', false)).toBe(false);
  });

  it('is true when idle and waiting on the operator', () => {
    expect(deriveNeedsYou('awaiting_approval', false)).toBe(true);
    expect(deriveNeedsYou('paused', false)).toBe(true);
    expect(deriveNeedsYou('scoping', false)).toBe(true); // grilling, between turns
    expect(deriveNeedsYou('open', false)).toBe(true);
    expect(deriveNeedsYou('failed', false)).toBe(true); // failed run needs you to act
  });
});
