import { Inject, Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Raw, Repository } from 'typeorm';
import { DB_CONNECTION } from '../persistence/database.module';
import { JobEntity } from '../persistence/entities';
import { retryResumeNudge, sessionLimitResetNudge } from '../prompt-kit/harness/seed-catalog';
import { CHAT_SURFACE, type ChatSurface } from '../surface/chat-surface.port';
import { DriverStoreService } from './driver-store.service';
import { ThreadDriver } from './thread-driver.service';

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
      this.surface.seedSystemNotification?.(job.repo_id, job.id, resumeNudge, {
        orgId: job.org_id,
        seedRow: isRetry
          ? 'skip'
          : {
              label: 'Auto-resuming after the session limit reset.',
              chunkKey: `seed:sessionlimit:${job.id}:${Date.now()}`,
            },
      });
      await this.driverStore.setSessionResume(job.id, null, null);
      return;
    }
    this.logger.warn(
      `job ${job.id} has a due resume clock but no recognized lane (${lane ?? 'none'}) — clearing defensively`,
    );
    await this.driverStore.setSessionResume(job.id, null, null);
  }
}
