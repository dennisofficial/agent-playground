import { describe, expect, it } from 'vitest';
import { deriveNeedsYou } from './job';

/**
 * `deriveNeedsYou` is the single server-owned definition of the sidebar "alert dot": a thread needs the
 * operator when the AI is NOT actively working (no live turn, no running build) and is NOT terminal.
 */
describe('deriveNeedsYou', () => {
  it('is false while a conversational turn is streaming, regardless of status', () => {
    for (const status of [
      'open',
      'planning',
      'awaiting_approval',
      'running',
      'paused',
      'failed',
    ]) {
      expect(deriveNeedsYou(status, true, false, false)).toBe(false);
    }
  });

  it('is false when the build is running (AI working)', () => {
    expect(deriveNeedsYou('running', false, false, false)).toBe(false);
  });

  it('is false for terminal states (done / cancelled)', () => {
    expect(deriveNeedsYou('done', false, false, false)).toBe(false);
    expect(deriveNeedsYou('cancelled', false, false, false)).toBe(false);
  });

  it('is true when idle and waiting on the operator', () => {
    expect(deriveNeedsYou('awaiting_approval', false, false, false)).toBe(true);
    expect(deriveNeedsYou('awaiting_ship_review', false, false, false)).toBe(true); // parked at the ship gate
    expect(deriveNeedsYou('paused', false, false, false)).toBe(true);
    expect(deriveNeedsYou('planning', false, false, false)).toBe(true); // grilling, between turns
    expect(deriveNeedsYou('open', false, false, false)).toBe(true);
    expect(deriveNeedsYou('failed', false, false, false)).toBe(true); // failed run needs you to act
  });

  it('is true when blocked on the durable question gate, even when otherwise idle', () => {
    // The brain asked via `ask_question` and the answering turn ended: status is back to an idle
    // conversational state and no turn streams, but the operator still owes an answer.
    expect(deriveNeedsYou('open', false, true, false)).toBe(true);
    expect(deriveNeedsYou('planning', false, true, false)).toBe(true);
  });

  it('the question gate overrides every other axis (turn streaming / running / terminal)', () => {
    // An open question (`open_question_count > 0`) is definitionally "needs you" — it wins over a stray
    // live turn, a running build, and even a terminal status.
    expect(deriveNeedsYou('planning', true, true, false)).toBe(true);
    expect(deriveNeedsYou('running', false, true, false)).toBe(true);
    expect(deriveNeedsYou('done', false, true, false)).toBe(true);
  });

  it('a deleting job never needs you — it wins even over the question gate', () => {
    // The job is being torn down and about to vanish; it must never light the sidebar dot, regardless of
    // a stray open question or live turn (deleting is checked before the question gate).
    expect(deriveNeedsYou('deleting', false, false, false)).toBe(false);
    expect(deriveNeedsYou('deleting', false, true, false)).toBe(false);
    expect(deriveNeedsYou('deleting', true, true, false)).toBe(false);
  });

  it('halted signals needs-you even when actively working (running/plan_review)', () => {
    expect(deriveNeedsYou('running', false, false, true)).toBe(true);
    expect(deriveNeedsYou('running', true, false, true)).toBe(true); // even mid-turn
    expect(deriveNeedsYou('planning', false, false, true)).toBe(true);
    expect(deriveNeedsYou('plan_review', false, false, true)).toBe(true);
  });

  it('deleting still wins over halted', () => {
    expect(deriveNeedsYou('deleting', false, false, true)).toBe(false);
  });
});
