import { Inject, Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Raw, Repository } from 'typeorm';
import { DB_CONNECTION } from '../persistence/database.module';
import { JobEntity } from '../persistence/entities';
// Direct port path (NOT the '../surface' barrel) to stay clear of a SurfaceModule ↔ DriverModule cycle.
import { retryResumeNudge, sessionLimitResetNudge } from '../prompt-kit/harness/seed-catalog';
import { CHAT_SURFACE, type ChatSurface } from '../surface/chat-surface.port';
import { DriverStoreService } from './driver-store.service';
import { ThreadDriver } from './thread-driver.service';

/**
 * The SESSION-RESUME SWEEP — the auto-resume half of "park a lane on a Claude session limit, then un-park it
 * once the reset passes". Runs on the driver's leader-gated timer (mirroring {@link GitStateReconciler}): a
 * `tick()` finds every job whose durable `session_resume_at` clock is DUE (`<= now()`) and resumes its lane
 * by the parked `session_resume.lane`:
 *
 *  - `build` → {@link ThreadDriver.resumePaused} (clears the `session_limit` halt + the resume clock, re-drives).
 *  - `main`  → seed a NON-persisted system notification that wakes the brain to continue the SAME session,
 *    then clear the resume clock (the Main lane has no `halt`, so the clock is the only park marker).
 *
 * Fail-soft PER JOB: one bad job (gone, malformed lane) is logged + its clock cleared defensively so it can
 * never stall the sweep or re-fire forever. Leader-only, so no two processes double-resume the same lane.
 */
@Injectable()
export class SessionResumeSweep {
  private readonly logger = new Logger(SessionResumeSweep.name);

  constructor(
    @InjectRepository(JobEntity, DB_CONNECTION)
    private readonly jobs: Repository<JobEntity>,
    private readonly driver: ThreadDriver,
    @Inject(CHAT_SURFACE) private readonly surface: ChatSurface,
    private readonly driverStore: DriverStoreService,
  ) {}

  /**
   * Resume every lane whose auto-resume clock is DUE. Returns the count resumed. Each job is handled in its
   * own try/catch so a single failure never aborts the rest of the sweep.
   */
  async tick(): Promise<number> {
    const due = await this.jobs.find({
      where: {
        session_resume_at: Raw((alias) => `${alias} IS NOT NULL AND ${alias} <= now()`),
      },
    });
    let resumed = 0;
    for (const job of due) {
      try {
        await this.resumeOne(job);
        resumed++;
      } catch (err) {
        this.logger.warn(`session-resume failed for job ${job.id}: ${err}`);
      }
    }
    return resumed;
  }

  private async resumeOne(job: JobEntity): Promise<void> {
    const lane = job.session_resume?.lane;
    const isRetry = job.session_resume?.kind === 'retry';
    if (lane === 'build') {
      // A host-backstop retry park has NO halt (a retrying job isn't "paused"), so it takes the no-halt
      // re-drive; a session-limit / blocked-credentials park uses resumePaused (clears the halt AND the clock,
      // then re-drives the preserved phase). This is the restart-only backstop — the in-process 10s timer is
      // the primary re-drive; whichever fires first clears the clock, so no double re-drive.
      if (isRetry) {
        await this.driver.resumeRetry(job.id);
      } else {
        await this.driver.resumePaused(job.id);
      }
      return;
    }
    if (lane === 'main') {
      const resumeNudge = isRetry
        ? retryResumeNudge(job.title ?? undefined)
        : sessionLimitResetNudge(job.title ?? undefined);
      // A retry re-drive is SILENT (`'skip'`: drives the turn, renders no pill) — it mirrors the in-process
      // host-retry timer's silent seed, and the operator already saw the "Reconnecting to Claude — auto-retry
      // n/N…" notice. A session-limit auto-resume keeps its informative pill (the operator wants to know the
      // lane un-parked after the limit reset).
      this.surface.seedSystemNotification?.(job.repo_id, job.id, resumeNudge, {
        orgId: job.org_id,
        seedRow: isRetry
          ? 'skip'
          : {
              label: 'Auto-resuming after the session limit reset.',
              chunkKey: `seed:sessionlimit:${job.id}:${Date.now()}`,
            },
      });
      // The Main lane has no halt — the clock is the only park marker, so clear it here (unlike the build lane,
      // where resumePaused already cleared it).
      await this.driverStore.setSessionResume(job.id, null, null);
      return;
    }
    // Unknown / missing lane — clear the clock defensively so a malformed park can't re-fire forever.
    this.logger.warn(
      `job ${job.id} has a due resume clock but no recognized lane (${lane ?? 'none'}) — clearing defensively`,
    );
    await this.driverStore.setSessionResume(job.id, null, null);
  }
}
