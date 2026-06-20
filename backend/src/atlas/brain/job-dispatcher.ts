import { Logger } from '@nestjs/common';
import type { Job } from '../domain';

/**
 * The DISPATCH SEAM — the brain's "hands" edge, the exact mirror of W2's `STIMULUS_CONSUMER` on the
 * intake edge. The conversational brain produces a fully-formed `Job` (a locked decision record + its
 * high-level section list + the thread it lives in, all persisted) and calls
 * `JOB_DISPATCHER.dispatch(job)`. What runs the sections is on the OTHER side of this token.
 *
 * W3 binds the logging NO-OP below as the default so the whole brain → dispatch path is observable
 * end-to-end before any driver exists. W4 overrides it with `{ provide: JOB_DISPATCHER, useExisting:
 * SectionDriver }` — ZERO changes anywhere else (same pattern W3 used to replace W2's no-op consumer).
 *
 * Contract for W4's `SectionDriver`:
 *  - `dispatch(job)` is called ONCE per approved/clean job, AFTER the job + its decision record +
 *    section rows are already persisted (status `running`). The driver loads the section/phase rows
 *    off the job id and walks them; it does not re-plan the high-level list. `dispatch` should return
 *    promptly (kick off the async drive, do not block the caller for the whole build) — the brain
 *    does not await the build, only the hand-off.
 *  - On a feature: `job.kind === 'feature'`, sections are the approved high-level briefs (gap-numbered
 *    ordinals 10, 20, 30…). On a bugfix: `job.kind === 'bugfix'`, exactly one section.
 *  - The job already carries `decisionRecordId` (the locked record) and `threadId` (where to post
 *    progress / park-and-ask). `featureBranch` / `prUrl` are null — the driver fills them.
 */
export const JOB_DISPATCHER = Symbol('ATLAS_JOB_DISPATCHER');

/** The downstream of the dispatch seam: a single `dispatch(job)` the brain hands an approved job to. */
export interface JobDispatcher {
  /**
   * Take ownership of a persisted, ready-to-run `Job` (status `running`, sections persisted). Kick off
   * the deterministic section/phase drive; do not block the brain on the whole build.
   */
  dispatch(job: Job): Promise<void>;
}

/**
 * The W3 default dispatcher — a logging NO-OP. It makes the brain → hands hand-off observable (every
 * dispatched job logs its kind/title/sections) without running anything. W4 replaces it with the real
 * `SectionDriver`; until then this proves the seam is wired and an approved job reaches the driver's
 * doorstep.
 */
export class LoggingJobDispatcher implements JobDispatcher {
  private readonly logger = new Logger('JobDispatcher');

  async dispatch(job: Job): Promise<void> {
    this.logger.log(
      `[no-op dispatch] JOB ${job.id} kind=${job.kind} title="${job.title}" ` +
        `project=${job.projectId} thread=${job.threadId} ` +
        `decisionRecord=${job.decisionRecordId ?? '(none)'} — W4 SectionDriver will run this`,
    );
  }
}
