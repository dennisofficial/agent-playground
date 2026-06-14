import { describe, expect, it } from 'vitest';
import { EWorkerEngineName } from '@harness/engines/worker-engine.port';
import type { Session } from '../sessions/session-registry.port';
// Captured against the pre-refactor session-relay-prompt.ts / board-seed-prompt.ts, then repointed to
// ./seed.prompts — proves the tmpl rewrite of the relay/seed prompts is byte-identical.
import {
  planReadySeed,
  sessionRelayPrompt,
  ticketApprovedSeed,
} from './seed.prompts';

const session = (overrides: Partial<Session> = {}): Session => ({
  id: 'sess-001',
  task: 'wire the auth API',
  worktreeId: 'wt-001',
  status: 'idle',
  notifyThread: 'tui:main',
  ownerBot: 'alex',
  team: 'local',
  project: 'local',
  engine: EWorkerEngineName.CLAUDE,
  mode: 'plan',
  turns: 1,
  lastReport: 'the report body',
  ...overrides,
});

describe('conductor seed/relay prompts byte-stability', () => {
  it('relay: failed', () => {
    expect(
      sessionRelayPrompt(session({ status: 'failed', error: 'boom' })),
    ).toMatchSnapshot();
  });
  it('relay: questions', () => {
    expect(
      sessionRelayPrompt(
        session({ lastReportKind: 'questions', lastReport: 'Q1: which auth?' }),
      ),
    ).toMatchSnapshot();
  });
  it('relay: plan (board-linked)', () => {
    expect(
      sessionRelayPrompt(session({ lastReportKind: 'plan', boardTaskId: 7 })),
    ).toMatchSnapshot();
  });
  it('relay: plan (unlinked)', () => {
    expect(
      sessionRelayPrompt(session({ lastReportKind: 'plan' })),
    ).toMatchSnapshot();
  });
  it('relay: default prose', () => {
    expect(sessionRelayPrompt(session())).toMatchSnapshot();
  });
  it('planReadySeed', () => {
    expect(planReadySeed({ taskId: 7, employee: 'alex' })).toMatchSnapshot();
  });
  it('ticketApprovedSeed (worktree resolvable)', () => {
    expect(
      ticketApprovedSeed({ taskId: 7, worktreeId: 'wt-001' }),
    ).toMatchSnapshot();
  });
  it('ticketApprovedSeed (worktree gone)', () => {
    expect(ticketApprovedSeed({ taskId: 7 })).toMatchSnapshot();
  });
});
