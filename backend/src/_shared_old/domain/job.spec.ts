import type { JobActivity } from '@workspace/shared';
import { describe, expect, it } from 'vitest';
import { deriveNeedsYou } from './job';

type Input = Parameters<typeof deriveNeedsYou>[0];

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
  'retrying',
];

describe('deriveNeedsYou', () => {
  it('is false for terminal phases (done / cancelled / deleting / archived)', () => {
    for (const status of ['done', 'cancelled', 'deleting', 'archived']) {
      expect(deriveNeedsYou(at({ status }))).toBe(false);
      expect(deriveNeedsYou(at({ status, openQuestion: true, halted: true }))).toBe(false);
    }
  });

  it('is false whenever the system is working (any non-idle activity)', () => {
    for (const activity of NON_IDLE_ACTIVITIES) {
      expect(deriveNeedsYou(at({ status: 'planning', activity }))).toBe(false);
      expect(deriveNeedsYou(at({ status: 'open', activity }))).toBe(false);
    }
    expect(deriveNeedsYou(at({ status: 'planning', activity: 'plan_review' }))).toBe(false);
  });

  it('is true when idle in an operator-owned phase with no gate', () => {
    for (const status of ['open', 'planning', 'awaiting_approval', 'awaiting_ship_review']) {
      expect(deriveNeedsYou(at({ status }))).toBe(true);
    }
  });

  it('is false when idle in a system-owned phase with no gate', () => {
    expect(deriveNeedsYou(at({ status: 'running' }))).toBe(false);
    expect(deriveNeedsYou(at({ status: 'plan_review' }))).toBe(false);
  });

  it('soft-gates (open question) light the dot when idle, but are suppressed while working', () => {
    expect(deriveNeedsYou(at({ status: 'open', openQuestion: true }))).toBe(true);
    expect(deriveNeedsYou(at({ status: 'running', openQuestion: true }))).toBe(true);
    expect(deriveNeedsYou(at({ status: 'planning', openQuestion: true, activity: 'turn' }))).toBe(
      false,
    );
  });

  it('soft-gates (awaiting secret) light the dot when idle, but are suppressed while working', () => {
    expect(deriveNeedsYou(at({ status: 'running', awaitingSecret: true }))).toBe(true);
    expect(deriveNeedsYou(at({ status: 'open', awaitingSecret: true }))).toBe(true);
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
    expect(deriveNeedsYou(at({ status: 'running', halted: true, activity: 'build' }))).toBe(true);
    expect(deriveNeedsYou(at({ status: 'planning', halted: true, activity: 'plan_review' }))).toBe(
      true,
    );
    expect(deriveNeedsYou(at({ status: 'deleting', halted: true, activity: 'build' }))).toBe(false);
  });
});
