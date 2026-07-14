import { Logger } from '@nestjs/common';
import type { Job } from '../domain';

/**
 * The DISPATCH SEAM — the brain's "hands" edge, the exact mirror of the `BRAIN_SINK` port on the
 * intake edge. The conversational brain produces a fully-scoped `Thread` (a locked decision record + its
 * high-level thread list, all persisted) and calls `JOB_DISPATCHER.dispatch(thread)`. What runs the
 * threads is on the OTHER side of this token. (The thread IS the build unit — the former `jobs` layer.)
 *
 * W3 binds the logging NO-OP below as the default so the whole brain → dispatch path is observable
 * end-to-end before any driver exists. W4 overrides it with `{ provide: JOB_DISPATCHER, useExisting:
 * ThreadDriver }` — ZERO changes anywhere else (same pattern W3 used to replace W2's no-op consumer).
 *
 * Contract for W4's `ThreadDriver`:
 *  - `dispatch(thread)` is called ONCE per approved/clean thread, AFTER the decision record + thread
 *    rows are persisted (status `running`). The driver loads the thread/step rows off the thread id
 *    and walks them; it does not re-plan the high-level list. `dispatch` should return promptly (kick
 *    off the async drive, do not block the caller for the whole build).
 *  - On a feature: `thread.kind === 'feature'`, threads are the approved high-level briefs
 *    (gap-numbered ordinals 10, 20, 30…). On a bugfix: `thread.kind === 'bugfix'`, exactly one thread.
 *  - The thread already carries `decisionRecordId` (the locked record). `featureBranch` / `prUrl` are
 *    null — the driver fills them.
 */
export const JOB_DISPATCHER = Symbol('JOB_DISPATCHER');

/** The downstream of the dispatch seam: `dispatch(thread)` the brain hands an approved build to, plus
 *  `retry(jobId)` the operator triggers to re-drive a halted (failed/paused) build. */
export interface JobDispatcher {
  /**
   * Take ownership of a persisted, ready-to-run `Thread` (status `running`, threads persisted). Kick
   * off the deterministic thread/step drive; do not block the brain on the whole build.
   */
  dispatch(thread: Job): Promise<void>;
  /**
   * Re-drive a HALTED build (status `failed` or `paused`) from the operator's Retry button. Flips the
   * job back to `running` and re-enters the SAME resumable drive — fast-forwarding done threads/steps and
   * already-committed batches, continuing at the first unfinished one. Idempotent / safe: a no-op when
   * the job isn't in a retryable state. Returns promptly (async drive).
   */
  retry(jobId: string): Promise<void>;
  /**
   * Phase 3 (ADR 0004 rider 4) — the brain's autonomous re-drive of a HALTED thread (`blocked`/`incomplete`/
   * `failed`), distinct from `retry` (which no-ops on a `blocked` job that stays `running`). Clears the
   * thread's terminal record + halt signal, injects the brain's fix `guidance` into the thread's orientation
   * cheat-sheet, and re-enters the resumable drive (fast-forwarding done batches, re-running the un-committed
   * halted one). Budget-gated by the caller (`retry_thread` claims `halt_fix_attempts` first). Returns promptly.
   */
  redriveThread(
    jobId: string,
    threadId: string,
    guidance?: string,
    cap?: number,
  ): Promise<{ ok: boolean; attempt?: number; reason?: string }>;
  /**
   * "Retry now" operator lever for a thread held on a verification-judge outage (`judge_unavailable`). Re-arms
   * the (judge-cap) re-drive budget and re-drives — bounded by a fresh judge budget. Refuses a thread not held
   * on a judge outage. Returns promptly.
   */
  operatorRetryStuckThread(
    jobId: string,
    threadId: string,
  ): Promise<{ ok: boolean; reason?: string }>;
  /**
   * "Skip & accept" operator lever for a thread held on a verification-judge outage. Sets a durable marker and
   * re-enters the drive, which finalizes the thread `done` with the live sandbox. Safety-gated: the hold must
   * be `judge_unavailable` AND the static checks must have passed. Returns promptly.
   */
  operatorAcceptStuckThread(
    jobId: string,
    threadId: string,
  ): Promise<{ ok: boolean; reason?: string }>;
  /**
   * "Ship without review" operator lever for a job held on a `codex_review_unavailable` (master_review
   * Codex-outage) hold. Marks `master_review` skipped/done and re-enters the drive, which proceeds to the
   * normal ship-review gate (the human diff review still runs; only the automated Codex whole-diff pass is
   * skipped). Refuses when the job isn't in that hold. Returns promptly.
   */
  operatorShipWithoutReview(jobId: string): Promise<{ ok: boolean; reason?: string }>;
  /**
   * Deliver any OWED thread-halt brain wakes (ADR 0004 rider 4) — fired from `drive()` once the job leaves the
   * active window (so a re-drive can re-enter cleanly) and from the leader boot sweep (crash recovery). For
   * each owed thread it wakes the job brain to triage the halt, then stamps the dedup marker. Scoped to one
   * job when `jobId` is given, else all jobs. Idempotent (generation-keyed stamp). Returns promptly.
   */
  deliverOwedHaltWakes(jobId?: string): Promise<void>;
  /**
   * Decision d1 — deliver any OWED completion brain wakes (`'final'`/`'notable'`), the clean-completion
   * mirror of {@link deliverOwedHaltWakes}. Fired from the periodic chat-delivery sweep and the leader boot
   * sweep. Scoped to one job when `jobId` is given, else all jobs. Idempotent. Returns promptly.
   */
  deliverOwedDoneWakes(jobId?: string): Promise<void>;
}

/**
 * The W3 default dispatcher — a logging NO-OP. It makes the brain → hands hand-off observable (every
 * dispatched thread logs its kind/title/threads) without running anything. W4 replaces it with the real
 * `ThreadDriver`; until then this proves the seam is wired and an approved build reaches the driver's
 * doorstep.
 */
export class LoggingJobDispatcher implements JobDispatcher {
  private readonly logger = new Logger('JobDispatcher');

  async dispatch(thread: Job): Promise<void> {
    this.logger.log(
      `[no-op dispatch] THREAD ${thread.id} kind=${thread.kind} title="${thread.title}" ` +
        `repo=${thread.repoId} ` +
        `decisionRecord=${thread.decisionRecordId ?? '(none)'} — W4 ThreadDriver will run this`,
    );
  }

  async retry(jobId: string): Promise<void> {
    this.logger.log(
      `[no-op retry] THREAD ${jobId} — W4 ThreadDriver will re-drive this`,
    );
  }

  async redriveThread(
    jobId: string,
    threadId: string,
    _guidance?: string,
    _cap?: number,
  ): Promise<{ ok: boolean; attempt?: number; reason?: string }> {
    this.logger.log(
      `[no-op redriveThread] THREAD ${jobId} thread=${threadId} — W4 ThreadDriver will re-drive this`,
    );
    return { ok: true, attempt: 0 };
  }

  async operatorRetryStuckThread(
    jobId: string,
    threadId: string,
  ): Promise<{ ok: boolean; reason?: string }> {
    this.logger.log(
      `[no-op operatorRetryStuckThread] THREAD ${jobId} thread=${threadId} — W4 ThreadDriver will re-drive this`,
    );
    return { ok: true };
  }

  async operatorAcceptStuckThread(
    jobId: string,
    threadId: string,
  ): Promise<{ ok: boolean; reason?: string }> {
    this.logger.log(
      `[no-op operatorAcceptStuckThread] THREAD ${jobId} thread=${threadId} — W4 ThreadDriver will finalize this`,
    );
    return { ok: true };
  }

  async operatorShipWithoutReview(jobId: string): Promise<{ ok: boolean; reason?: string }> {
    this.logger.log(
      `[no-op operatorShipWithoutReview] THREAD ${jobId} — W4 ThreadDriver will finalize this`,
    );
    return { ok: true };
  }

  async deliverOwedHaltWakes(jobId?: string): Promise<void> {
    this.logger.log(
      `[no-op deliverOwedHaltWakes] ${jobId ?? '(all)'} — W4 ThreadDriver will wake the brain`,
    );
  }

  async deliverOwedDoneWakes(jobId?: string): Promise<void> {
    this.logger.log(
      `[no-op deliverOwedDoneWakes] ${jobId ?? '(all)'} — W4 ThreadDriver will wake the brain`,
    );
  }
}
