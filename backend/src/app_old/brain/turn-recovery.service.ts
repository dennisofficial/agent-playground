import { Inject, Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { Repository } from 'typeorm';
import { JobBootstrapService } from '../job-bootstrap/job-bootstrap.service';
import { DB_CONNECTION } from '../persistence/database.module';
import { JobSandboxEntity, TranscriptMessageEntity } from '../persistence/entities';
import { SANDBOX_PROVIDER, type SandboxProvider } from '../sandbox/sandbox-provider.port';
import { TurnRegistry } from '../sandbox/turn-registry.service';
import { parseSessionTranscriptTurns, type SessionTranscript } from './session-transcript';
import { backfillThreadFromTurns } from './turn-backfill';

const WATCH_INTERVAL_MS = 8_000;
const WATCH_TIMEOUT_MS = 20 * 60_000;

type RecoverStatus =
  | 'recovered' // blocks were back-filled
  | 'already' // the turn's reply is already persisted (nothing to do)
  | 'incomplete' // the newest turn hasn't reached end_turn yet (still generating — watch it)
  | 'absent'; // no transcript on disk for this thread

@Injectable()
export class TurnRecoveryService implements OnModuleDestroy {
  private readonly logger = new Logger(TurnRecoveryService.name);
  private watchTimer?: ReturnType<typeof setInterval>;
  private destroyed = false;

  constructor(
    @InjectRepository(TranscriptMessageEntity, DB_CONNECTION)
    private readonly messages: Repository<TranscriptMessageEntity>,
    @InjectRepository(JobSandboxEntity, DB_CONNECTION)
    private readonly sandboxRows: Repository<JobSandboxEntity>,
    @Inject(SANDBOX_PROVIDER) private readonly sandboxes: SandboxProvider,
    private readonly turnRegistry: TurnRegistry,
    private readonly jobBootstrap: JobBootstrapService,
  ) {}

  onModuleDestroy(): void {
    this.destroyed = true;
    this.clearWatch();
  }

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
        this.logger.warn(`turn recovery watch failed for thread=${jobId}: ${err}`);
        return 'absent' as RecoverStatus;
      });
      if (status !== 'incomplete') pending.delete(jobId); // recovered / already / absent → done watching
    }
  }

  private async candidateThreadIds(): Promise<string[]> {
    const rows = await this.sandboxRows
      .createQueryBuilder('s')
      .select('s.job_id', 'jobId')
      .where("s.lifecycle <> 'closed'")
      .getRawMany<{ jobId: string }>();
    const out: string[] = [];
    for (const { jobId } of rows) {
      const live = await this.turnRegistry.hasRunningForThread(jobId).catch(() => false);
      if (!live) out.push(jobId);
    }
    return out;
  }

  private async recoverThread(jobId: string): Promise<RecoverStatus> {
    const projectsDir = this.sandboxes.brainTranscriptProjectsDir(jobId);
    if (!projectsDir || !existsSync(projectsDir)) return 'absent';

    const transcript = this.latestTranscript(projectsDir);
    if (!transcript || transcript.turns.length === 0) return 'absent';

    if (transcript.sessionId) {
      let row: JobSandboxEntity | null;
      try {
        row = await this.sandboxRows.findOne({ where: { job_id: jobId } });
      } catch (err) {
        this.logger.warn(
          `turn recovery: compaction-skip lookup failed for thread=${jobId} — skipping to be safe: ${err}`,
        );
        return 'absent';
      }
      if (row?.compacting_session_id === transcript.sessionId) return 'absent';
    }

    const turns = transcript.turns;
    const lastEndedClean = turns[turns.length - 1].endedClean;
    const recoverable = turns.filter((t, i) => t.endedClean || i < turns.length - 1);

    const threadId = await this.jobBootstrap.planningThreadId(jobId);
    const inserted = await backfillThreadFromTurns(this.messages, jobId, threadId, recoverable);
    if (inserted > 0)
      this.logger.log(`Turn recovery: back-filled ${inserted} block(s) for thread=${jobId}`);

    if (!lastEndedClean) return inserted > 0 ? 'recovered' : 'incomplete';
    return inserted > 0 ? 'recovered' : 'already';
  }

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
        } catch {}
      }
    }
    return newest ? parseSessionTranscriptTurns(readFileSync(newest.path, 'utf8')) : null;
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
