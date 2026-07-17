import { describe, expect, it } from 'vitest';

import type { UnblockBlockerInfo } from '@shared/domain';
import { renderBornBlockedUnblockPrefix, wakeUnblockedRunningJobBody } from '../seed-catalog';

const merged: UnblockBlockerInfo = {
  jobId: 'job-aaa',
  title: 'Refactor auth module',
  how: 'merged',
};
const closed: UnblockBlockerInfo = {
  jobId: 'job-bbb',
  title: 'Session DB migration',
  how: 'closed_unmerged',
};

describe('unblock wake message content', () => {
  describe('wakeUnblockedRunningJobBody (blocked MID-WORK, resumes)', () => {
    it('names the blocker + how it resolved, frames the block as soft, and steers rebase/re-scope/resume', () => {
      const body = wakeUnblockedRunningJobBody([merged]);
      // Names the blocker (title + id + resolution).
      expect(body).toContain('Refactor auth module');
      expect(body).toContain('job job-aaa');
      expect(body).toContain('(merged)');
      // Soft-reason framing.
      expect(body).toContain('NOT necessarily a hard dependency');
      // Reorientation guidance.
      expect(body).toContain('Rebase onto the latest base branch');
      expect(body).toContain('change the scope of your work');
      // Resume language IS present for a mid-work job.
      expect(body).toContain('resume the work you had planned');
      // All blockers merged → no "did not merge" caveat.
      expect(body).not.toContain('did NOT merge');
    });

    it('adds the "did not merge" caveat when a blocker did not land, with its how label', () => {
      const body = wakeUnblockedRunningJobBody([merged, closed]);
      expect(body).toContain('Session DB migration');
      expect(body).toContain('(PR closed without merging)');
      expect(body).toContain('1 of those job(s) did NOT merge');
    });

    it('degrades to a generic line when no blockers are named (e.g. the sweep backstop)', () => {
      const body = wakeUnblockedRunningJobBody([]);
      expect(body).toContain('Every job that was blocking you has resolved.');
      expect(body).not.toContain('You were blocked by');
    });

    it('labels an operator-removed edge as a lifted block', () => {
      const body = wakeUnblockedRunningJobBody([
        { jobId: 'job-ccc', title: 'Some job', how: 'removed' },
      ]);
      expect(body).toContain('(block lifted by the operator)');
    });
  });

  describe('renderBornBlockedUnblockPrefix (BORN-BLOCKED, first turn)', () => {
    it('names the blockers and frames a fresh start with NO resume/plan-assumptions language', () => {
      const prefix = renderBornBlockedUnblockPrefix([merged]);
      expect(prefix).toContain('Refactor auth module');
      expect(prefix).toContain('CREATED already blocked');
      expect(prefix).toContain('have NOT started any work yet');
      expect(prefix).toContain('Start from the latest base branch');
      expect(prefix).toContain('Factor those jobs into your plan');
      // A born-blocked job has no prior plan to resume.
      expect(prefix).not.toContain('resume the work you had planned');
      expect(prefix).not.toContain("plan's assumptions");
    });
  });
});
