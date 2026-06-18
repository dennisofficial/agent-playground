import { describe, expect, it } from 'vitest';
import type { BoardEvent } from '../memory/board-events.bus';
import { boardEventRelayPrompt, sectionQuestionsNotice } from './seed-relay';

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

  it('narrates a terminal run-failed with the reason, the section, and the open-backlog recovery', () => {
    const failed: BoardEvent = {
      kind: 'run-failed',
      team: 't',
      taskId: 2,
      reason: 'session sess-9 (kind=feature, mode=plan) failed',
      section: 'backend',
    };
    const prompt = boardEventRelayPrompt(failed);
    expect(prompt).toContain('#2');
    expect(prompt).toMatch(/failed/i);
    expect(prompt).toContain('session sess-9 (kind=feature, mode=plan) failed');
    expect(prompt).toContain('backend');
    // Tells Atlas the ticket is recoverable (back on the open backlog) and that recovery is his to drive.
    expect(prompt).toMatch(/open backlog/i);
    expect(prompt).toMatch(/re-dispatch/i);
  });

  it('run-failed omits the section clause for a ticket-level/bugfix failure', () => {
    const failed: BoardEvent = {
      kind: 'run-failed',
      team: 't',
      taskId: 5,
      reason: 'shipTask failed — ship blew up',
    };
    const prompt = boardEventRelayPrompt(failed);
    expect(prompt).toContain('#5');
    expect(prompt).toContain('ship blew up');
    expect(prompt).not.toMatch(/while on the '/);
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

  it('renders an advisory stage-findings relay with the chip/park/skip menu (not paused)', () => {
    const found: BoardEvent = {
      kind: 'stage-findings',
      team: 't',
      taskId: 7,
      stage: 'phase_backend',
      section: 'backend',
      findings: '- the auth middleware double-reads the body\n- dead config flag LEGACY_MODE',
    };
    const prompt = boardEventRelayPrompt(found);
    expect(prompt).toContain('#7');
    expect(prompt).toContain('backend');
    expect(prompt).toContain('double-reads the body');
    // The triage menu — chip vs silent park vs skip — and explicitly NOT paused (advisory).
    expect(prompt).toContain('suggest_task');
    expect(prompt).toContain('enqueue_finding');
    expect(prompt).not.toMatch(/paused/i);
  });

  // The questions now reach the channel via `sectionQuestionsNotice` (a deterministic system post),
  // so the seed must NOT restate them — it carries only the routing instruction. Guards against a
  // regression where the verbatim questions leak back into the prompt (the duplication we removed).
  it('section-questions seed routes by number WITHOUT restating the questions', () => {
    const event: BoardEvent = {
      kind: 'section-questions',
      team: 't',
      taskId: 9,
      section: 'backend',
      questions: 'Q1: which package?\nQ2: SSE or WebSocket?',
    };
    const prompt = boardEventRelayPrompt(event);
    expect(prompt).toContain('#9');
    expect(prompt).toContain('answer_section(9');
    // The verbatim questions are deliberately absent — they live on the channel now.
    expect(prompt).not.toContain('which package?');
    expect(prompt).not.toContain('SSE or WebSocket?');
    expect(prompt).toMatch(/posted to the channel/i);
  });
});

describe('sectionQuestionsNotice', () => {
  it('renders a header + the VERBATIM questions for a section run', () => {
    const notice = sectionQuestionsNotice({
      kind: 'section-questions',
      team: 't',
      taskId: 9,
      section: 'backend',
      questions: 'Q1: which package?\nQ2: SSE or WebSocket?',
    });
    expect(notice).toContain('Pipeline #9');
    expect(notice).toContain('backend');
    // Verbatim, unaltered — this is the whole point of the deterministic notice.
    expect(notice).toContain('Q1: which package?\nQ2: SSE or WebSocket?');
  });

  it('omits the section for a bugfix run (no section)', () => {
    const notice = sectionQuestionsNotice({
      kind: 'section-questions',
      team: 't',
      taskId: 4,
      questions: 'Q1: reproduce on main?',
    });
    expect(notice).toContain('Pipeline #4');
    expect(notice).not.toContain(' · ');
    expect(notice).toContain('Q1: reproduce on main?');
  });
});
