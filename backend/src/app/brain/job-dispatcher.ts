import { Logger } from '@nestjs/common';
import type { Thread } from '../domain';

/**
 * The DISPATCH SEAM — the brain's "hands" edge, the exact mirror of W2's `STIMULUS_CONSUMER` on the
 * intake edge. The conversational brain produces a fully-scoped `Thread` (a locked decision record + its
 * high-level track list, all persisted) and calls `JOB_DISPATCHER.dispatch(thread)`. What runs the
 * tracks is on the OTHER side of this token. (The thread IS the build unit — the former `jobs` layer.)
 *
 * W3 binds the logging NO-OP below as the default so the whole brain → dispatch path is observable
 * end-to-end before any driver exists. W4 overrides it with `{ provide: JOB_DISPATCHER, useExisting:
 * TrackDriver }` — ZERO changes anywhere else (same pattern W3 used to replace W2's no-op consumer).
 *
 * Contract for W4's `TrackDriver`:
 *  - `dispatch(thread)` is called ONCE per approved/clean thread, AFTER the decision record + track
 *    rows are persisted (status `running`). The driver loads the track/step rows off the thread id
 *    and walks them; it does not re-plan the high-level list. `dispatch` should return promptly (kick
 *    off the async drive, do not block the caller for the whole build).
 *  - On a feature: `thread.kind === 'feature'`, tracks are the approved high-level briefs
 *    (gap-numbered ordinals 10, 20, 30…). On a bugfix: `thread.kind === 'bugfix'`, exactly one track.
 *  - The thread already carries `decisionRecordId` (the locked record). `featureBranch` / `prUrl` are
 *    null — the driver fills them.
 */
export const JOB_DISPATCHER = Symbol('JOB_DISPATCHER');

/** The downstream of the dispatch seam: a single `dispatch(thread)` the brain hands an approved build to. */
export interface JobDispatcher {
  /**
   * Take ownership of a persisted, ready-to-run `Thread` (status `running`, tracks persisted). Kick
   * off the deterministic track/step drive; do not block the brain on the whole build.
   */
  dispatch(thread: Thread): Promise<void>;
}

/**
 * The W3 default dispatcher — a logging NO-OP. It makes the brain → hands hand-off observable (every
 * dispatched thread logs its kind/title/tracks) without running anything. W4 replaces it with the real
 * `TrackDriver`; until then this proves the seam is wired and an approved build reaches the driver's
 * doorstep.
 */
export class LoggingJobDispatcher implements JobDispatcher {
  private readonly logger = new Logger('JobDispatcher');

  async dispatch(thread: Thread): Promise<void> {
    this.logger.log(
      `[no-op dispatch] THREAD ${thread.id} kind=${thread.kind} title="${thread.title}" ` +
        `repo=${thread.repoId} ` +
        `decisionRecord=${thread.decisionRecordId ?? '(none)'} — W4 TrackDriver will run this`,
    );
  }
}
