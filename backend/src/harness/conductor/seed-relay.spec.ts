import { describe, expect, it } from 'vitest';
import type { BoardEvent } from '../memory/board-events.bus';
import { boardEventRelayPrompt } from './seed-relay';

describe('boardEventRelayPrompt', () => {
  // The partition that keeps the conductor and PipelineRunnerService from double-handling: the plan-gate
  // resume (ticket-approved) and plan-attached are owned elsewhere, so the conductor must not narrate them.
  it('returns null for events the conductor must not consume', () => {
    const ticketApproved: BoardEvent = {
      kind: 'ticket-approved',
      team: 't',
      taskId: 1,
    };
    const planAttached: BoardEvent = {
      kind: 'plan-attached',
      team: 't',
      taskId: 1,
      employee: 'alex',
    };
    expect(boardEventRelayPrompt(ticketApproved)).toBeNull();
    expect(boardEventRelayPrompt(planAttached)).toBeNull();
  });

  it('narrates the four human-facing PR/review events with the key handles', () => {
    const prOpened: BoardEvent = {
      kind: 'pr-opened',
      team: 't',
      taskId: 7,
      employee: 'riley',
      prUrl: 'https://gh/pr/7',
    };
    const prReady: BoardEvent = {
      kind: 'pr-ready',
      team: 't',
      taskId: 7,
      employee: 'riley',
      prUrl: 'https://gh/pr/7',
    };
    const selfReviewReady: BoardEvent = {
      kind: 'self-review-ready',
      team: 't',
      taskId: 7,
      employee: 'riley',
      prUrl: 'https://gh/pr/7',
      noteId: 42,
      worktreeId: 'wt-1',
    };
    const selfReviewFailed: BoardEvent = {
      kind: 'self-review-failed',
      team: 't',
      taskId: 7,
      employee: 'riley',
      reason: 'fix loop exhausted',
    };

    const opened = boardEventRelayPrompt(prOpened);
    expect(opened).toContain('#7');
    expect(opened).toContain('https://gh/pr/7');

    const ready = boardEventRelayPrompt(prReady);
    expect(ready).toContain('#7');
    expect(ready).toContain('https://gh/pr/7');

    const reviewReady = boardEventRelayPrompt(selfReviewReady);
    expect(reviewReady).toContain('#7');
    expect(reviewReady).toContain('note #42');
    expect(reviewReady).toContain('https://gh/pr/7');

    const reviewFailed = boardEventRelayPrompt(selfReviewFailed);
    expect(reviewFailed).toContain('#7');
    expect(reviewFailed).toContain('fix loop exhausted');
  });

  it('renders a stage-decision wake-up with the findings + the action menu', () => {
    const decision: BoardEvent = {
      kind: 'stage-decision',
      team: 't',
      taskId: 7,
      stage: 'full implementation review',
      findings: 'contract mismatch at the BE/FE seam',
      allowedActions: [
        { action: 'dispatch_fixup_session(7)', description: 'fix + re-review + ship' },
        { action: "reopen_section(7, '<section>')", description: 'replan a section' },
      ],
    };
    const prompt = boardEventRelayPrompt(decision);
    expect(prompt).toContain('#7');
    expect(prompt).toContain('full implementation review');
    expect(prompt).toContain('contract mismatch at the BE/FE seam');
    expect(prompt).toContain('dispatch_fixup_session(7)');
    expect(prompt).toContain("reopen_section(7, '<section>')");
    // The run is paused on Atlas's call.
    expect(prompt).toMatch(/paused/i);
  });
});
