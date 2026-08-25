import { Controller, type MessageEvent, Param, ParseUUIDPipe, Post, Sse } from '@nestjs/common';
import type { JobListItem } from '@workspace/shared';
import { Observable } from 'rxjs';
import { HostTransportService } from '../host-transport/host-transport.service';
import { JobService } from './job.service';

@Controller('jobs')
export class JobController {
  constructor(
    private readonly jobs: JobService,
    private readonly hostTransport: HostTransportService,
  ) {}

  @Post(':jobId/archive')
  archive(@Param('jobId', ParseUUIDPipe) jobId: string): Promise<JobListItem> {
    return this.jobs.archive(jobId);
  }

  @Sse(':jobId/turn/stream')
  streamTurn(@Param('jobId', ParseUUIDPipe) jobId: string): Observable<MessageEvent> {
    return new Observable<MessageEvent>((subscriber) => {
      const abort = new AbortController();
      void (async () => {
        try {
          await this.jobs.assertAccess(jobId);
          for await (const frame of this.hostTransport.streamLive(jobId, abort.signal)) {
            subscriber.next({ type: frame.kind, data: frame });
          }
          subscriber.complete();
        } catch (err) {
          subscriber.error(err);
        }
      })();
      return () => abort.abort();
    });
  }
}
