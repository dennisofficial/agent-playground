import { describe, expect, it } from 'vitest';
import { deriveNeedsYou } from './job';

/**
 * `deriveNeedsYou` is the single server-owned definition of the sidebar "alert dot": a job needs the
 * operator when the phase is one of the operator-owned resting states, or a durable human-input gate is
 * open (question / secret). Terminal phases never light the dot; `blocked` is a dependency park the
 * system owns. The old job-level `activity`/`halted` axes were dropped — `status` alone carries phase.
 */

type Input = Parameters<typeof deriveNeedsYou>[0];

// An ungated job — override one axis at a time in each case.
function at(overrides: Partial<Input> & { status: string }): Input {
  return {
    openQuestion: false,
    awaitingSecret: false,
    ...overrides,
  };
}

describe('deriveNeedsYou', () => {
  it('is false for terminal phases (merged / cancelled / deleting)', () => {
    for (const status of ['merged', 'cancelled', 'deleting']) {
      expect(deriveNeedsYou(at({ status }))).toBe(false);
      // Terminal wins over every gate — even an open question cannot light a dying job's dot.
      expect(
        deriveNeedsYou(at({ status, openQuestion: true, awaitingSecret: true })),
      ).toBe(false);
    }
  });

  it('is true when in an operator-owned resting phase with no gate', () => {
    for (const status of ['awaiting_approval', 'ready', 'amending']) {
      expect(deriveNeedsYou(at({ status }))).toBe(true);
    }
  });

  it('is false in a system-owned phase with no gate', () => {
    // These phases are the system's to advance — an ungated job there waits on the pipeline, not the operator.
    for (const status of ['scoping', 'planning', 'plan_reviewing', 'building', 'master_review', 'shipping', 'pr_open']) {
      expect(deriveNeedsYou(at({ status }))).toBe(false);
    }
  });

  it('is false for a dependency-parked (blocked) job — the system owns the next step', () => {
    expect(deriveNeedsYou(at({ status: 'blocked' }))).toBe(false);
  });

  it('an open question lights the dot in any non-terminal, non-blocked phase', () => {
    expect(deriveNeedsYou(at({ status: 'building', openQuestion: true }))).toBe(
      true,
    );
    expect(deriveNeedsYou(at({ status: 'scoping', openQuestion: true }))).toBe(
      true,
    );
    // But never for a terminal or dependency-parked job.
    expect(
      deriveNeedsYou(at({ status: 'merged', openQuestion: true })),
    ).toBe(false);
    expect(
      deriveNeedsYou(at({ status: 'blocked', openQuestion: true })),
    ).toBe(false);
  });

  it('an outstanding secret request lights the dot in any non-terminal, non-blocked phase', () => {
    expect(
      deriveNeedsYou(at({ status: 'building', awaitingSecret: true })),
    ).toBe(true);
    expect(deriveNeedsYou(at({ status: 'scoping', awaitingSecret: true }))).toBe(
      true,
    );
    expect(
      deriveNeedsYou(at({ status: 'deleting', awaitingSecret: true })),
    ).toBe(false);
  });
});
