import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { JobDependencyService } from '../job-deps';
import { DB_CONNECTION } from '../persistence/database.module';
import { JobEntity } from '../persistence/entities';

/**
 * The JOB-UNBLOCK SWEEP — the durable backstop for the event-driven wake funnel
 * ({@link JobDependencyService.onBlockerResolved}). If a terminal-resolution event is DROPPED (a crash
 * between resolving a blocker and waking its dependents), a dependent can strand `blocked` with every
 * blocker already terminal-or-absent. This leader-gated sweep re-runs the same idempotent reconcile for
 * every `blocked` job, so nothing stays parked once its blockers are all done.
 *
 * Fail-soft PER JOB (one bad reconcile never aborts the rest) and idempotent (the unblock is a conditional
 * UPDATE ... WHERE status='blocked'), mirroring {@link SessionResumeSweep}. Leader-only, so two processes
 * never double-wake the same job.
 */
@Injectable()
export class JobUnblockSweep {
  private readonly logger = new Logger(JobUnblockSweep.name);

  constructor(
    @InjectRepository(JobEntity, DB_CONNECTION)
    private readonly jobs: Repository<JobEntity>,
    private readonly jobDeps: JobDependencyService,
  ) {}

  /** Reconcile every `blocked` job; unblock+wake any whose blockers are all terminal-or-absent. Returns
   *  the count unblocked. Each job is handled in its own try/catch so one failure never aborts the sweep. */
  async tick(): Promise<number> {
    const blocked = await this.jobs.find({ where: { status: 'blocked' } });
    let unblocked = 0;
    for (const job of blocked) {
      try {
        if (await this.jobDeps.reconcileBlockedJob(job.id)) unblocked++;
      } catch (err) {
        this.logger.warn(`job-unblock sweep failed for job ${job.id}: ${err}`);
      }
    }
    return unblocked;
  }
}
