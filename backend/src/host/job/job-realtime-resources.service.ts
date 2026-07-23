import { Injectable, type OnModuleInit } from '@nestjs/common';
import { RealtimeResourceRegistry } from '@workspace/pg-realtime/nest-realtime';
import type { User } from '../../_lib/database/entities/user.entity';
import { JobService } from './job.service';

@Injectable()
export class JobRealtimeResourcesService implements OnModuleInit {
  constructor(
    private readonly registry: RealtimeResourceRegistry,
    private readonly jobs: JobService,
  ) {}

  onModuleInit(): void {
    // The job detail view — the flat job row joined with its thread-group→thread tree
    // (`JobService.get`/`JobView`), keyed by `jobId`. Any change to the job itself or its
    // groups/threads re-runs the composed load, RLS-scoped via the caller's principal.
    this.registry.register<User>('job_detail', {
      triggers: (params) => {
        const jobId = params.jobId as string;
        return [
          { model: 'jobs', filter: { id: jobId } },
          { model: 'thread_groups', filter: { jobId } },
          { model: 'threads', filter: { jobId } },
        ];
      },
      load: async (params) => {
        const jobId = params.jobId as string;
        const view = await this.jobs.get(jobId);
        return [{ pk: jobId, row: view as unknown as Record<string, unknown> }];
      },
    });
  }
}
