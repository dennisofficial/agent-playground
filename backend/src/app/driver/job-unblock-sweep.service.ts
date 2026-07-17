import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { JobDependencyService } from '../job-deps/job-dependency.service';
import { DB_CONNECTION } from '../persistence/database.module';
import { JobEntity } from '../persistence/entities';

@Injectable()
export class JobUnblockSweep {
  private readonly logger = new Logger(JobUnblockSweep.name);

  constructor(
    @InjectRepository(JobEntity, DB_CONNECTION)
    private readonly jobs: Repository<JobEntity>,
    private readonly jobDeps: JobDependencyService,
  ) {}

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
