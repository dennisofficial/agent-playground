import type { JobActivity } from '@workspace/shared';
import { describe, expect, it } from 'vitest';
import { deriveNeedsYou } from './job';

/**
 * `deriveNeedsYou` is the single server-owned definition of the sidebar "alert dot": a thread needs the
 * operator when the SYSTEM is NOT working (`activity === 'idle'`), the phase is NOT terminal, and either a
 * gate is open (halt / question / secret) or the phase is operator-owned. Three axes: phase (`status`),
 * activity (what the system is doing), and the hard/soft gates.
 */

type Input = Parameters<typeof deriveNeedsYou>[0];

// A fully-idle, ungated job — override one axis at a time in each case.
function at(overrides: Partial<Input> & { status: string }): Input {
  return {
    activity: 'idle',
    openQuestion: false,
    awaitingSecret: false,
    halted: false,
    ...overrides,
  };
}

const NON_IDLE_ACTIVITIES: JobActivity[] = [
  'turn',
  'plan_review',
  'build',
  'master_review',
  // A host-backstop retry parks the job on `retrying` during the 10s backoff — the system is still
  // "working" (reconnecting), so it must NOT light the operator dot.
  'retrying',
];

describe('deriveNeedsYou', () => {
  it('is false for terminal phases (done / cancelled / deleting / archived)', () => {
    for (const status of ['done', 'cancelled', 'deleting', 'archived']) {
      expect(deriveNeedsYou(at({ status }))).toBe(false);
      // Terminal wins over every gate — even an open question or a halt cannot light a dying job's dot.
      expect(deriveNeedsYou(at({ status, openQuestion: true, halted: true }))).toBe(false);
    }
  });

  it('is false whenever the system is working (any non-idle activity)', () => {
    for (const activity of NON_IDLE_ACTIVITIES) {
      expect(deriveNeedsYou(at({ status: 'planning', activity }))).toBe(false);
      expect(deriveNeedsYou(at({ status: 'open', activity }))).toBe(false);
    }
    // The regression: a plan review runs while the phase sits at `planning` — must NOT light the dot.
    expect(deriveNeedsYou(at({ status: 'planning', activity: 'plan_review' }))).toBe(false);
  });

  it('is true when idle in an operator-owned phase with no gate', () => {
    for (const status of ['open', 'planning', 'awaiting_approval', 'awaiting_ship_review']) {
      expect(deriveNeedsYou(at({ status }))).toBe(true);
    }
  });

  it('is false when idle in a system-owned phase with no gate', () => {
    // `running` and `plan_review` phases are the system's to advance — an idle, ungated job there waits on
    // the pipeline, not the operator.
    expect(deriveNeedsYou(at({ status: 'running' }))).toBe(false);
    expect(deriveNeedsYou(at({ status: 'plan_review' }))).toBe(false);
  });

  it('soft-gates (open question) light the dot when idle, but are suppressed while working', () => {
    expect(deriveNeedsYou(at({ status: 'open', openQuestion: true }))).toBe(true);
    expect(deriveNeedsYou(at({ status: 'running', openQuestion: true }))).toBe(true);
    // Suppressed while the system works — the asking turn is still streaming.
    expect(deriveNeedsYou(at({ status: 'planning', openQuestion: true, activity: 'turn' }))).toBe(
      false,
    );
  });

  it('soft-gates (awaiting secret) light the dot when idle, but are suppressed while working', () => {
    expect(deriveNeedsYou(at({ status: 'running', awaitingSecret: true }))).toBe(true);
    expect(deriveNeedsYou(at({ status: 'open', awaitingSecret: true }))).toBe(true);
    // Suppressed while a review owns the next step.
    expect(
      deriveNeedsYou(
        at({
          status: 'planning',
          awaitingSecret: true,
          activity: 'plan_review',
        }),
      ),
    ).toBe(false);
  });

  it('the HARD halt gate lights the dot even while a stale activity says "working"', () => {
    // A halt means the system STOPPED — it must surface even if a failed build left `activity` non-idle
    // (defense in depth behind the halt writers that also clear activity).
    expect(deriveNeedsYou(at({ status: 'running', halted: true, activity: 'build' }))).toBe(true);
    expect(deriveNeedsYou(at({ status: 'planning', halted: true, activity: 'plan_review' }))).toBe(
      true,
    );
    // But never for a terminal job.
    expect(deriveNeedsYou(at({ status: 'deleting', halted: true, activity: 'build' }))).toBe(false);
  });
});
