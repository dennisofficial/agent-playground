import { describe, expect, it } from 'vitest';
import { deriveNeedsYou } from './job';

/**
 * `deriveNeedsYou` is the single server-owned definition of the sidebar "alert dot": a thread needs the
 * operator when the AI is NOT actively working (no live turn, no running build, no Codex review in flight),
 * is NOT terminal, and is NOT halted (the separate failure/pause axis).
 */
describe('deriveNeedsYou', () => {
  it('is false while a conversational turn is streaming, regardless of status', () => {
    for (const status of [
      'open',
      'planning',
      'awaiting_approval',
      'running',
      'awaiting_ship_review',
      'plan_review',
    ]) {
      expect(deriveNeedsYou(status, true, false, false, false)).toBe(false);
    }
  });

  it('is false when the build is running (AI working)', () => {
    expect(deriveNeedsYou('running', false, false, false, false)).toBe(false);
  });

  it('is false for terminal states (done / cancelled)', () => {
    expect(deriveNeedsYou('done', false, false, false, false)).toBe(false);
    expect(deriveNeedsYou('cancelled', false, false, false, false)).toBe(false);
  });

  it('is true when idle and waiting on the operator', () => {
    expect(
      deriveNeedsYou('awaiting_approval', false, false, false, false),
    ).toBe(true);
    expect(
      deriveNeedsYou('awaiting_ship_review', false, false, false, false),
    ).toBe(true); // parked at the ship gate
    expect(deriveNeedsYou('planning', false, false, false, false)).toBe(true); // grilling, between turns
    expect(deriveNeedsYou('open', false, false, false, false)).toBe(true);
  });

  it('is true when halted (the failure/pause axis), whatever phase it halted in', () => {
    // `status` is now the pure build phase; failure / credential / budget / incomplete halts live on the
    // separate halt field. A halted job always needs you — even under a phase that is otherwise not a
    // needs-you state, like `running` (the old `failed`/`paused` status values used to encode this).
    expect(deriveNeedsYou('running', false, false, true, false)).toBe(true);
    expect(
      deriveNeedsYou('awaiting_ship_review', false, false, true, false),
    ).toBe(true);
  });

  it('is true when blocked on the durable question gate, even when otherwise idle', () => {
    // The brain asked via `ask_question` and the answering turn ended: status is back to an idle
    // conversational state and no turn streams, but the operator still owes an answer.
    expect(deriveNeedsYou('open', false, true, false, false)).toBe(true);
    expect(deriveNeedsYou('planning', false, true, false, false)).toBe(true);
  });

  it('the question gate overrides every other axis (turn streaming / running / terminal)', () => {
    // An open question (`open_question_count > 0`) is definitionally "needs you" — it wins over a stray
    // live turn, a running build, and even a terminal status.
    expect(deriveNeedsYou('planning', true, true, false, false)).toBe(true);
    expect(deriveNeedsYou('running', false, true, false, false)).toBe(true);
    expect(deriveNeedsYou('done', false, true, false, false)).toBe(true);
  });

  it('a deleting job never needs you — it wins even over the question gate and a halt', () => {
    // The job is being torn down and about to vanish; it must never light the sidebar dot, regardless of
    // a stray open question, a live turn, or a halt (deleting is checked before every other axis).
    expect(deriveNeedsYou('deleting', false, false, false, false)).toBe(false);
    expect(deriveNeedsYou('deleting', false, true, false, false)).toBe(false);
    expect(deriveNeedsYou('deleting', true, true, false, false)).toBe(false);
    expect(deriveNeedsYou('deleting', false, false, true, false)).toBe(false);
  });

  it('halted signals needs-you even when actively working (running/plan_review)', () => {
    expect(deriveNeedsYou('running', false, false, true, false)).toBe(true);
    expect(deriveNeedsYou('running', true, false, true, false)).toBe(true); // even mid-turn
    expect(deriveNeedsYou('planning', false, false, true, false)).toBe(true);
    expect(deriveNeedsYou('plan_review', false, false, true, false)).toBe(true);
  });

  it('is false while a Codex plan review is in flight, even when idle in planning', () => {
    // A `review_plan` runs while `status` stays `planning`; if the parent turn got finalized (turn_active
    // cleared) the old rule false-lit the dot. The running-review axis now suppresses it — the system owns
    // the next step, not the operator.
    expect(deriveNeedsYou('planning', false, false, false, true)).toBe(false);
    expect(deriveNeedsYou('open', false, false, false, true)).toBe(false);
  });

  it('a running review never overrides halted or the question gate', () => {
    // A genuinely dead review surfaces via halted (set on unrecoverable failure) or the question gate — the
    // review-running suppression must never mask those.
    expect(deriveNeedsYou('planning', false, false, true, true)).toBe(true); // halted wins
    expect(deriveNeedsYou('planning', false, true, false, true)).toBe(true); // open question wins
    expect(deriveNeedsYou('deleting', false, false, false, true)).toBe(false); // deleting still wins
  });
});
