import type { Session } from '../sessions/session-registry.port';
import { sessionRelayPrompt } from './session-relay-prompt';
import { EWorkerEngineName } from '@harness/engines/worker-engine.port';

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

describe('sessionRelayPrompt', () => {
  it('failed turns relay the error with retry/drop directions', () => {
    const out = sessionRelayPrompt(
      session({ status: 'failed', error: 'engine exploded' }),
    );
    expect(out).toContain('FAILED: engine exploded');
    expect(out).toContain('reply_session("sess-001"');
    expect(out).toContain('close_session("sess-001")');
  });

  it('a questions-report routes WHAT/WHY to Dennis, holds it open, and forbids a mode change', () => {
    const out = sessionRelayPrompt(
      session({ lastReportKind: 'questions', lastReport: 'Q1: which auth?' }),
    );
    expect(out).toContain('needs ANSWERS');
    expect(out).toContain('Q1: which auth?');
    expect(out).toContain("Dennis's call");
    expect(out).toContain('leave it OPEN until he answers');
    expect(out).toContain('ONE reply_session("sess-001"');
    expect(out).toContain('do NOT change mode');
  });

  it('a board-linked plan reports the auto-attach and routes to Sam, never a self-set status', () => {
    const out = sessionRelayPrompt(
      session({ lastReportKind: 'plan', boardTaskId: 7, planAttached: true }),
    );
    expect(out).toContain('finished its PLAN');
    expect(out).toContain('automatically ATTACHED to ticket #7');
    expect(out).toContain('@Sam reviews every attached plan');
    expect(out).toContain('Keep THIS session OPEN');
    expect(out).toContain('close_session("sess-001")');
    expect(out).toContain('Do NOT set any board status yourself');
    expect(out).toContain("do NOT reply with mode 'execute'");
    expect(out).not.toContain('update_board_task');
  });

  it('a FAILED auto-attach tells the owner to park the plan on the ticket via add_note', () => {
    const out = sessionRelayPrompt(
      session({ lastReportKind: 'plan', boardTaskId: 7, planAttached: false }),
    );
    expect(out).toContain('FAILED');
    expect(out).toContain('add_note(7,');
    expect(out).not.toContain('automatically ATTACHED');
  });

  it('an unlinked plan leaves the call to the owner but names the gate', () => {
    const out = sessionRelayPrompt(session({ lastReportKind: 'plan' }));
    expect(out).toContain('finished its PLAN');
    expect(out).not.toContain('update_board_task');
    expect(out).toContain('the approval gate may refuse the flip');
  });

  it('an ordinary report keeps the original relay shape', () => {
    const out = sessionRelayPrompt(session());
    expect(out).toContain('reported back:');
    expect(out).toContain('the report body');
    expect(out).toContain('Route its questions: WHAT to build or WHY');
  });
});
