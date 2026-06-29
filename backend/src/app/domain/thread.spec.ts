import { describe, expect, it } from 'vitest';
import { deriveNeedsYou } from './thread';

/**
 * `deriveNeedsYou` is the single server-owned definition of the sidebar "alert dot": a thread needs the
 * operator when the AI is NOT actively working (no live turn, no running build) and is NOT terminal.
 */
describe('deriveNeedsYou', () => {
  it('is false while a conversational turn is streaming, regardless of status', () => {
    for (const status of ['open', 'planning', 'awaiting_approval', 'running', 'paused', 'failed']) {
      expect(deriveNeedsYou(status, true, false)).toBe(false);
    }
  });

  it('is false when the build is running (AI working)', () => {
    expect(deriveNeedsYou('running', false, false)).toBe(false);
  });

  it('is false for terminal states (done / cancelled)', () => {
    expect(deriveNeedsYou('done', false, false)).toBe(false);
    expect(deriveNeedsYou('cancelled', false, false)).toBe(false);
  });

  it('is true when idle and waiting on the operator', () => {
    expect(deriveNeedsYou('awaiting_approval', false, false)).toBe(true);
    expect(deriveNeedsYou('paused', false, false)).toBe(true);
    expect(deriveNeedsYou('planning', false, false)).toBe(true); // grilling, between turns
    expect(deriveNeedsYou('open', false, false)).toBe(true);
    expect(deriveNeedsYou('failed', false, false)).toBe(true); // failed run needs you to act
  });

  it('is true when blocked on the durable question gate, even when otherwise idle', () => {
    // The brain asked via `ask_question` and the answering turn ended: status is back to an idle
    // conversational state and no turn streams, but the operator still owes an answer.
    expect(deriveNeedsYou('open', false, true)).toBe(true);
    expect(deriveNeedsYou('planning', false, true)).toBe(true);
  });

  it('the question gate overrides every other axis (turn streaming / running / terminal)', () => {
    // A non-null `awaiting_question_id` is definitionally "needs you" — it wins over a stray live turn,
    // a running build, and even a terminal status.
    expect(deriveNeedsYou('planning', true, true)).toBe(true);
    expect(deriveNeedsYou('running', false, true)).toBe(true);
    expect(deriveNeedsYou('done', false, true)).toBe(true);
  });
});
