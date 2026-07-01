import { Inject, Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { Repository } from 'typeorm';
import { DB_CONNECTION } from '../persistence/database.module';
import { MessageEntity, JobSandboxEntity } from '../persistence/entities';
import { SANDBOX_PROVIDER, type SandboxProvider } from '../sandbox/sandbox-provider.port';
import { parseSessionTranscriptTail, type RecoveredBlock, type TranscriptTail } from './session-transcript';

/** How many trailing chars of the final reply we match against `messages` to decide "already persisted".
 *  Long enough to be unique to the turn, short enough to tolerate trivial trailing differences. */
const FINAL_REPLY_FINGERPRINT_LEN = 160;

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
 * Crash recovery for a brain turn lost when the backend restarts mid-stream (e.g. a CI/CD deploy while
 * the operator is mid-chat). The turn runs inside the sandbox container via `docker exec`; the durable
 * transcript blocks are written to `messages` only at turn END (`TurnHarnessFactory.finish()`), so a
 * restart before that loses them — even though the engine's `docker exec` is reparented to the container's
 * init and KEEPS RUNNING to completion, writing its SDK session JSONL to the HOST-mounted agent-home bind.
 *
 * Two cooperating paths, both on leader promotion:
 *  - {@link recoverInterruptedTurns} — the immediate pass: for every non-closed sandbox thread, if its
 *    newest transcript already reached `end_turn` but its reply isn't in `messages`, back-fill it.
 *  - {@link finishAndRecover} — the deploy case: the turn was still GENERATING at restart. We watch the
 *    threads that were mid-flight (their `turn_active` flag was set) until their orphaned engine reaches
 *    `end_turn`, recover each as it finishes, then stop. Triggered by the restart, scoped to the affected
 *    threads, self-terminating — NOT a perpetual poll.
 *
 * Detection reads the JSONL truth (not message ordering): a first/cold turn persists a "Setting up an
 * isolated workspace…" notice AFTER the operator prompt, so "last row is the operator" would wrongly skip
 * it. We instead key off whether the newest completed turn's FINAL reply is present in `messages`, and
 * dedupe individual blocks on the JSONL line `uuid` we stamp into `meta.sdkUuid`.
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
    for (const threadId of threadIds) {
      try {
        if ((await this.recoverThread(threadId)) === 'recovered') recovered++;
      } catch (err) {
        this.logger.warn(`turn recovery failed for thread=${threadId}: ${err}`);
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
    this.logger.log(`Turn recovery: watching ${pending.size} mid-flight turn(s) to completion`);

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
    for (const threadId of [...pending]) {
      if (Date.now() > deadline) {
        pending.delete(threadId);
        this.logger.warn(`turn recovery: stopped watching thread=${threadId} (timed out before end_turn)`);
        continue;
      }
      const status = await this.recoverThread(threadId).catch((err) => {
        this.logger.warn(`turn recovery watch failed for thread=${threadId}: ${err}`);
        return 'absent' as RecoverStatus;
      });
      if (status !== 'incomplete') pending.delete(threadId); // recovered / already / absent → done watching
    }
  }

  /** Threads to inspect: every non-closed sandbox (a brain session exists or may exist on disk). */
  private async candidateThreadIds(): Promise<string[]> {
    const rows = await this.sandboxRows
      .createQueryBuilder('s')
      .select('s.job_id', 'threadId')
      .where("s.lifecycle <> 'closed'")
      .getRawMany<{ threadId: string }>();
    return rows.map((r) => r.threadId);
  }

  /** Inspect a thread's NEWEST transcript and recover it if it's a completed-but-unpersisted turn. */
  private async recoverThread(threadId: string): Promise<RecoverStatus> {
    const projectsDir = this.sandboxes.brainTranscriptProjectsDir(threadId);
    if (!projectsDir || !existsSync(projectsDir)) return 'absent';

    const tail = this.latestTranscript(projectsDir);
    if (!tail) return 'absent';
    // Newest session reached end_turn? If not, the current turn is still generating — watch, don't recover.
    if (!tail.endedClean || !tail.blocks.length) return 'incomplete';

    // Already persisted? The turn's FINAL reply text is the fingerprint — a normally-persisted turn has it
    // in `messages`; an interrupted turn does not (the provisioning notice etc. never matches it).
    const finalReply = [...tail.blocks].reverse().find((b) => b.kind === 'chat')?.text;
    if (finalReply && (await this.finalReplyPersisted(threadId, finalReply))) return 'already';

    // Per-block idempotency for recovery re-runs (keyed on the JSONL line uuid we stamp into meta).
    const seen = await this.persistedSdkUuids(threadId);
    const fresh = tail.blocks.filter((b) => {
      const u = b.meta.sdkUuid;
      return typeof u !== 'string' || !seen.has(u);
    });
    if (!fresh.length) return 'already';

    let lastMs = 0;
    for (const b of fresh) {
      // Strictly-monotonic created_at (mirrors TurnHarnessFactory.stamp) so the recovered rows sort in
      // transcript order, after the operator prompt, even when SDK line timestamps tie.
      const base = b.emittedAt instanceof Date && !Number.isNaN(b.emittedAt.getTime()) ? b.emittedAt.getTime() : Date.now();
      lastMs = Math.max(base, lastMs + 1);
      await this.appendBlock(threadId, b, new Date(lastMs));
    }
    this.logger.log(`Turn recovery: back-filled ${fresh.length} block(s) for thread=${threadId}`);
    return 'recovered';
  }

  /** Parse the MOST-RECENTLY-MODIFIED session JSONL (a thread can have several from resets; the newest is
   *  the current/last turn). Returning the newest — even if it's mid-write and NOT yet `endedClean` — is
   *  deliberate: an in-flight turn must read as `incomplete`, never fall back to an older completed turn. */
  private latestTranscript(projectsDir: string): TranscriptTail | null {
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
    return newest ? parseSessionTranscriptTail(readFileSync(newest.path, 'utf8')) : null;
  }

  /** Whether the turn's final reply is already a durable Atlas message (the "already persisted" guard). */
  private async finalReplyPersisted(threadId: string, finalReply: string): Promise<boolean> {
    const needle = finalReply.trim().slice(-FINAL_REPLY_FINGERPRINT_LEN);
    if (!needle) return false;
    const count = await this.messages
      .createQueryBuilder('m')
      .where('m.job_id = :threadId', { threadId })
      .andWhere("m.author_id = 'atlas'")
      .andWhere('position(:needle in m.text) > 0', { needle })
      .getCount();
    return count > 0;
  }

  /** The set of SDK `uuid`s already represented in this thread's durable messages — recovery-re-run guard. */
  private async persistedSdkUuids(threadId: string): Promise<Set<string>> {
    const rows: Array<{ u: string | null }> = await this.messages
      .createQueryBuilder('m')
      .select("m.meta ->> 'sdkUuid'", 'u')
      .where('m.job_id = :threadId', { threadId })
      .andWhere("m.meta ->> 'sdkUuid' IS NOT NULL")
      .getRawMany();
    return new Set(rows.map((r) => r.u).filter((u): u is string => typeof u === 'string'));
  }

  /** Write one recovered block as an Atlas-authored durable row (byte-compatible with `MessageBlockSink`). */
  private async appendBlock(threadId: string, block: RecoveredBlock, createdAt: Date): Promise<void> {
    await this.messages.save(
      this.messages.create({
        job_id: threadId,
        author: 'Atlas',
        author_id: 'atlas',
        author_bot_id: 'atlas',
        text: block.text ?? '',
        kind: block.kind,
        meta: block.meta,
        created_at: createdAt,
      }),
    );
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
