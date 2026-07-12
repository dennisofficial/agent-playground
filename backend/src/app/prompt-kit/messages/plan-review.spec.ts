import { describe, expect, it } from 'vitest';
import { renderPlanForReview, renderReReview, type PlanReviewInput } from './plan-review';

/**
 * Golden-snapshot baseline for the plan-review task PROSE strings — every snapshot captures CURRENT
 * output verbatim (a regression pass, not a spec of intent; see the sibling `prompt-kit` snapshot specs).
 * Locked BEFORE the `renderReviewIntent` extraction (dedupe with `brain/plan-review.eval.ts`'s hand-synced
 * copy) so that refactor is provably byte-identical.
 */

const fullInput: PlanReviewInput = {
  jobId: 'job-1',
  orgId: 'org-1',
  goal: "Show each user's last login time on their profile.",
  ticket: {
    number: 42,
    title: 'Surface last login on the profile page',
    body: 'Users have asked to see when they last signed in.',
  },
  overview: 'Stamp last_login_at on successful login and expose it on GET /users/:id.',
  decisions: [
    { decisionClass: 'data_model', title: 'Use a nullable timestamptz column', ruling: 'last_login_at' },
  ],
  threadTitles: ['Backend', 'Frontend'],
  stepsByThread: [
    [{ title: 'Add last_login_at column', brief: 'Migration + entity column.' }],
    [{ title: 'Render last login on the profile', brief: 'Format + display the timestamp.' }],
  ],
};

const minimalInput: PlanReviewInput = {
  jobId: 'job-2',
  orgId: 'org-1',
  goal: '',
  ticket: null,
  overview: 'A bugfix with no separate goal string.',
  decisions: [],
  threadTitles: [],
};

describe('plan-review task golden snapshots', () => {
  it('renderPlanForReview — full input (ticket + decisions + 2-thread steps)', async () => {
    await expect(renderPlanForReview(fullInput)).toMatchFileSnapshot(
      './__snapshots__/plan-review-full.txt',
    );
  });

  it('renderPlanForReview — minimal input (empty goal/ticket/decisions/threads)', async () => {
    await expect(renderPlanForReview(minimalInput)).toMatchFileSnapshot(
      './__snapshots__/plan-review-minimal.txt',
    );
  });

  it('renderReReview — with a note', async () => {
    await expect(renderReReview(fullInput, 'I added a NOT NULL default of null.')).toMatchFileSnapshot(
      './__snapshots__/plan-re-review-with-note.txt',
    );
  });

  it('renderReReview — without a note', async () => {
    await expect(renderReReview(fullInput)).toMatchFileSnapshot(
      './__snapshots__/plan-re-review-no-note.txt',
    );
  });
});
