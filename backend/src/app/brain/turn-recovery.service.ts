import {
  Inject,
  Injectable,
  Logger,
  type OnModuleDestroy,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { Repository } from 'typeorm';
import { JobBootstrapService } from '../job-bootstrap';
import { DB_CONNECTION } from '../persistence/database.module';
import { MessageEntity, JobSandboxEntity } from '../persistence/entities';
import {
  SANDBOX_PROVIDER,
  type SandboxProvider,
} from '../sandbox/sandbox-provider.port';
import { TurnRegistry } from '../sandbox/turn-registry.service';
import {
  parseSessionTranscriptTurns,
  type SessionTranscript,
} from './session-transcript';
import { backfillThreadFromTurns } from './turn-backfill';

/** Defaults for the mid-flight watcher: poll every 8s, give up after 20 min (longer than any brain turn). */
const WATCH_INTERVAL_MS = 8_000;
const WATCH_TIMEOUT_MS = 20 * 60_000;

/** Outcome of inspecting one thread's newest transcript. */
type RecoverStatus =
  | 'recovered' // blocks were back-filled
  | 'already' // the turn's reply is already persisted (nothing to do)
  | 'incomplete' // the newest turn hasn't reached end_turn yet (still generating — watch it)
  | 'absent'; // no transcript on disk for this thread

/**
 * The GROUND-TRUTH JSONL fallback backstop for brain turns lost from `messages`. The primary durability path
 * is now the Redis-streams transport (ADR 0001): a turn's live log is a durable Redis stream, and on boot the
 * leader re-attaches in-flight turns (`reattachOwnedTurns`) and persists them. But a turn can still slip
 * through — e.g. the watchdog finalizes a turn whose heartbeat went stale across a restart, deleting its
 * stream before re-attach runs; or a mid-turn interrupt is superseded by a new operator prompt (the SDK
 * session resumes fresh) — leaving the turn ONLY in the engine's SDK session JSONL (a HOST-mounted bind).
 * This service reads that JSONL and back-fills anything missing.
 *
 * It runs as a boot backstop AFTER re-attach, and only touches threads with NO live Redis turn
 * (`candidateThreadIds` filters on `TurnRegistry.hasRunningForThread`) so it can never double-insert a turn
 * re-attach is actively persisting. Unlike the tail-only original, it recovers turns STRANDED in the middle
 * of the session (an interrupted turn followed by later completed ones) — see {@link backfillThreadFromTurns}.
 *
 *  - {@link recoverInterruptedTurns} — the immediate pass: back-fill every candidate thread's newest session.
 *  - {@link finishAndRecover} — the watcher: for a thread whose tail turn is still GENERATING, poll until it
 *    reaches `end_turn`, back-filling as it completes, then stop. Self-terminating — NOT a perpetual poll.
 *
 * Detection reads the JSONL truth (not message ordering): each turn is back-filled unless its FINAL reply is
 * already present in `messages`, and individual blocks dedupe on the JSONL line `uuid` (`meta.sdkUuid`) + the
 * SDK tool_use id (`meta.id`). Interrupted (unpaired) tool calls are dropped — the next turn re-issues them.
 */
@Injectable()
export class TurnRecoveryService implements OnModuleDestroy {
  private readonly logger = new Logger(TurnRecoveryService.name);
  private watchTimer?: ReturnType<typeof setInterval>;
  private destroyed = false;

  constructor(
    @InjectRepository(MessageEntity, DB_CONNECTION)
    private readonly messages: Repository<MessageEntity>,
    @InjectRepository(JobSandboxEntity, DB_CONNECTION)
    private readonly sandboxRows: Repository<JobSandboxEntity>,
    @Inject(SANDBOX_PROVIDER) private readonly sandboxes: SandboxProvider,
    private readonly turnRegistry: TurnRegistry,
    // Resolves the job's planning-stage thread id — the anchor recovered brain-lane blocks are stamped
    // onto (`messages.thread_id` is NOT NULL). The @Global JobBootstrapModule supplies it live.
    private readonly jobBootstrap: JobBootstrapService,
  ) {}

  onModuleDestroy(): void {
    this.destroyed = true;
    this.clearWatch();
  }

  /**
   * Immediate pass: back-fill every thread whose newest completed turn isn't reflected in `messages`.
   * Best-effort and fail-soft per thread. Returns the number of threads back-filled.
   */
  async recoverInterruptedTurns(): Promise<number> {
    let threadIds: string[];
    try {
      threadIds = await this.candidateThreadIds();
    } catch (err) {
      this.logger.warn(`turn-recovery candidate scan failed: ${err}`);
      return 0;
    }
    let recovered = 0;
    for (const jobId of threadIds) {
      try {
        if ((await this.recoverThread(jobId)) === 'recovered') recovered++;
      } catch (err) {
        this.logger.warn(`turn recovery failed for thread=${jobId}: ${err}`);
      }
    }
    return recovered;
  }

  /**
   * Watch the given mid-flight threads (their turn was streaming when the process died) until each one's
   * orphaned engine finishes, recovering it as it completes. Returns once all are recovered or timed out.
   * Run in the BACKGROUND from the boot sweeps (do not await) — it self-terminates. Idempotent: a thread
   * already recovered by the immediate pass resolves instantly.
   */
  async finishAndRecover(
    threadIds: string[],
    opts: { intervalMs?: number; timeoutMs?: number } = {},
  ): Promise<void> {
    const intervalMs = opts.intervalMs ?? WATCH_INTERVAL_MS;
    const timeoutMs = opts.timeoutMs ?? WATCH_TIMEOUT_MS;
    const deadline = Date.now() + timeoutMs;
    const pending = new Set(threadIds);

    await this.sweep(pending, deadline);
    if (pending.size === 0 || this.destroyed) return;
    this.logger.log(
      `Turn recovery: watching ${pending.size} mid-flight turn(s) to completion`,
    );

    await new Promise<void>((resolve) => {
      this.watchTimer = setInterval(() => {
        if (this.destroyed) {
          this.clearWatch();
          resolve();
          return;
        }
        void this.sweep(pending, deadline).then(() => {
          if (pending.size === 0) {
            this.clearWatch();
            resolve();
          }
        });
      }, intervalMs);
    });
  }

  /** One watch tick: try to recover each pending thread; drop it unless it's still incomplete (and not
   *  past its deadline). */
  private async sweep(pending: Set<string>, deadline: number): Promise<void> {
    for (const jobId of [...pending]) {
      if (Date.now() > deadline) {
        pending.delete(jobId);
        this.logger.warn(
          `turn recovery: stopped watching thread=${jobId} (timed out before end_turn)`,
        );
        continue;
      }
      const status = await this.recoverThread(jobId).catch((err) => {
        this.logger.warn(
          `turn recovery watch failed for thread=${jobId}: ${err}`,
        );
        return 'absent' as RecoverStatus;
      });
      if (status !== 'incomplete') pending.delete(jobId); // recovered / already / absent → done watching
    }
  }

  /**
   * Threads to inspect: every non-closed sandbox (a brain session exists or may exist on disk), MINUS any
   * thread with a live Redis turn. This service is the ground-truth JSONL FALLBACK (see class doc) — it must
   * never touch a turn the Redis path is actively re-attaching (`reattachOne` will persist it via its own
   * harness), or the two would double-insert. A stranded/abandoned turn has no `running` registry row.
   */
  private async candidateThreadIds(): Promise<string[]> {
    const rows = await this.sandboxRows
      .createQueryBuilder('s')
      .select('s.job_id', 'jobId')
      .where("s.lifecycle <> 'closed'")
      .getRawMany<{ jobId: string }>();
    const out: string[] = [];
    for (const { jobId } of rows) {
      const live = await this.turnRegistry
        .hasRunningForThread(jobId)
        .catch(() => false);
      if (!live) out.push(jobId);
    }
    return out;
  }

  /**
   * Inspect a thread's NEWEST transcript and back-fill every completed-but-unpersisted turn — including a
   * turn STRANDED in the middle of the session (interrupted before `end_turn`, then superseded by a later
   * operator prompt so it's no longer the tail). The last turn is back-filled ONLY when it reached
   * `end_turn`: a not-yet-clean LAST turn may still be generating, so we leave it for the watcher / a later
   * pass and report `incomplete`. Idempotency + dedup + dropping interrupted tool calls live in
   * {@link backfillThreadFromTurns}.
   */
  private async recoverThread(jobId: string): Promise<RecoverStatus> {
    const projectsDir = this.sandboxes.brainTranscriptProjectsDir(jobId);
    if (!projectsDir || !existsSync(projectsDir)) return 'absent';

    const transcript = this.latestTranscript(projectsDir);
    if (!transcript || transcript.turns.length === 0) return 'absent';

    // COMPACTION skip: if this transcript is the session compaction is ABANDONING, its tail is the internal
    // summary turn — never back-fill it into the operator log (the leak this closes). Covers the post-reseed,
    // pre-fresh-session window; layered with `candidateThreadIds`' live-turn filter (which excludes a job
    // while its compaction turn is in flight). Both the boot pass and the `finishAndRecover` watcher funnel
    // here, so this one check defends every recovery path.
    if (transcript.sessionId) {
      let row: JobSandboxEntity | null;
      try {
        row = await this.sandboxRows.findOne({ where: { job_id: jobId } });
      } catch (err) {
        // Can't confirm this isn't the session compaction is abandoning — fail SAFE (skip) rather than risk
        // back-filling the internal summary turn into the operator log. Recovery retries on the next pass.
        this.logger.warn(
          `turn recovery: compaction-skip lookup failed for thread=${jobId} — skipping to be safe: ${err}`,
        );
        return 'absent';
      }
      if (row?.compacting_session_id === transcript.sessionId) return 'absent';
    }

    // A non-last turn is always superseded (a later prompt exists) ⇒ complete-or-abandoned, safe to
    // back-fill. The LAST turn is included only when it ended clean (else it may still be generating).
    const turns = transcript.turns;
    const lastEndedClean = turns[turns.length - 1].endedClean;
    const recoverable = turns.filter(
      (t, i) => t.endedClean || i < turns.length - 1,
    );

    const threadId = await this.jobBootstrap.planningThreadId(jobId);
    const inserted = await backfillThreadFromTurns(
      this.messages,
      jobId,
      threadId,
      recoverable,
    );
    if (inserted > 0)
      this.logger.log(
        `Turn recovery: back-filled ${inserted} block(s) for thread=${jobId}`,
      );

    // `incomplete` keeps the watcher polling until the tail turn completes; otherwise recovered/already.
    if (!lastEndedClean) return inserted > 0 ? 'recovered' : 'incomplete';
    return inserted > 0 ? 'recovered' : 'already';
  }

  /** Parse the MOST-RECENTLY-MODIFIED session JSONL (a thread can have several from resets; the newest is
   *  the current/last turn). Returning the newest — even if it's mid-write and NOT yet `endedClean` — is
   *  deliberate: an in-flight turn must read as `incomplete`, never fall back to an older completed turn. */
  private latestTranscript(projectsDir: string): SessionTranscript | null {
    let newest: { path: string; mtimeMs: number } | null = null;
    for (const slug of this.safeReaddir(projectsDir)) {
      const slugDir = join(projectsDir, slug);
      for (const name of this.safeReaddir(slugDir)) {
        if (!name.endsWith('.jsonl')) continue;
        const path = join(slugDir, name);
        try {
          const mtimeMs = statSync(path).mtimeMs;
          if (!newest || mtimeMs > newest.mtimeMs) newest = { path, mtimeMs };
        } catch {
          /* vanished between readdir and stat — skip */
        }
      }
    }
    return newest
      ? parseSessionTranscriptTurns(readFileSync(newest.path, 'utf8'))
      : null;
  }

  private clearWatch(): void {
    if (this.watchTimer) {
      clearInterval(this.watchTimer);
      this.watchTimer = undefined;
    }
  }

  private safeReaddir(dir: string): string[] {
    try {
      return readdirSync(dir);
    } catch {
      return [];
    }
  }
}
