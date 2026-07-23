import {
  Controller,
  Get,
  Inject,
  type MessageEvent,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Sse,
} from '@nestjs/common';
import { CurrentUser } from '@workspace/auth/server';
import { RealtimeEngine } from '@workspace/pg-realtime';
import { PG_REALTIME_ENGINE, sseObservable } from '@workspace/pg-realtime/nest';
import type {
  InboundMessageView,
  JobListItem,
  JobView,
  TaskView,
  ThreadGroupView,
  ThreadMessageView,
  ThreadView,
} from '@workspace/shared';
import { Observable } from 'rxjs';
import type { User } from '../../_lib/database/entities/user.entity';
import { HostTransportService } from '../host-transport/host-transport.service';
import { JobService } from './job.service';
import { LiveStateService } from './live-state.service';
import { MessageService } from './message.service';
import { TaskService } from './task.service';
import { ThreadService } from './thread.service';

@Controller('jobs')
export class JobController {
  constructor(
    private readonly jobs: JobService,
    private readonly threads: ThreadService,
    private readonly messages: MessageService,
    private readonly tasks: TaskService,
    private readonly live: LiveStateService,
    private readonly hostTransport: HostTransportService,
    @Inject(PG_REALTIME_ENGINE) private readonly realtime: RealtimeEngine,
  ) {}

  @Get()
  list(@Query('repoId') repoId?: string): Promise<JobListItem[]> {
    return this.jobs.list(repoId);
  }

  /** Realtime job list. The @Rls guard scopes rows to the caller's orgs; `repoId` narrows. */
  @Sse('realtime')
  streamJobs(
    @CurrentUser() user: User,
    @Query('repoId') repoId?: string,
  ): Observable<MessageEvent> {
    return sseObservable(() =>
      this.realtime.openSubscription({ model: 'jobs', user, filter: repoId ? { repoId } : {} }),
    );
  }

  @Get(':jobId')
  get(@Param('jobId', ParseUUIDPipe) jobId: string): Promise<JobView> {
    return this.jobs.get(jobId);
  }

  @Post(':jobId/archive')
  archive(@Param('jobId', ParseUUIDPipe) jobId: string): Promise<JobListItem> {
    return this.jobs.archive(jobId);
  }

  @Get(':jobId/thread-groups')
  async groups(@Param('jobId', ParseUUIDPipe) jobId: string): Promise<ThreadGroupView[]> {
    await this.jobs.assertAccess(jobId);
    return this.threads.listGroups(jobId);
  }

  @Sse(':jobId/thread-groups/realtime')
  streamGroups(
    @CurrentUser() user: User,
    @Param('jobId', ParseUUIDPipe) jobId: string,
  ): Observable<MessageEvent> {
    return sseObservable(() =>
      this.realtime.openSubscription({ model: 'thread_groups', user, filter: { jobId } }),
    );
  }

  @Get(':jobId/threads')
  async listThreads(
    @Param('jobId', ParseUUIDPipe) jobId: string,
    @Query('groupId') groupId?: string,
    @Query('kind') kind?: string,
  ): Promise<ThreadView[]> {
    await this.jobs.assertAccess(jobId);
    return this.threads.listThreads(jobId, { groupId, kind });
  }

  @Sse(':jobId/threads/realtime')
  streamThreads(
    @CurrentUser() user: User,
    @Param('jobId', ParseUUIDPipe) jobId: string,
  ): Observable<MessageEvent> {
    return sseObservable(() =>
      this.realtime.openSubscription({ model: 'threads', user, filter: { jobId } }),
    );
  }

  /** The whole job's transcript (all threads) — the workspace fetches this once and scopes per lane. */
  @Get(':jobId/messages')
  async listJobMessages(
    @Param('jobId', ParseUUIDPipe) jobId: string,
  ): Promise<ThreadMessageView[]> {
    await this.jobs.assertAccess(jobId);
    return this.messages.listJobMessages(jobId);
  }

  @Sse(':jobId/messages/realtime')
  streamJobMessages(
    @CurrentUser() user: User,
    @Param('jobId', ParseUUIDPipe) jobId: string,
  ): Observable<MessageEvent> {
    return sseObservable(() =>
      this.realtime.openSubscription({ model: 'thread_messages', user, filter: { jobId } }),
    );
  }

  @Get(':jobId/threads/:threadId/messages')
  async listMessages(
    @Param('jobId', ParseUUIDPipe) jobId: string,
    @Param('threadId', ParseUUIDPipe) threadId: string,
  ): Promise<ThreadMessageView[]> {
    await this.jobs.assertAccess(jobId);
    return this.messages.listMessages(jobId, threadId);
  }

  @Sse(':jobId/threads/:threadId/messages/realtime')
  streamMessages(
    @CurrentUser() user: User,
    @Param('jobId', ParseUUIDPipe) jobId: string,
    @Param('threadId', ParseUUIDPipe) threadId: string,
  ): Observable<MessageEvent> {
    return sseObservable(() =>
      this.realtime.openSubscription({ model: 'thread_messages', user, filter: { threadId } }),
    );
  }

  @Get(':jobId/tasks')
  async listTasks(@Param('jobId', ParseUUIDPipe) jobId: string): Promise<TaskView[]> {
    await this.jobs.assertAccess(jobId);
    return this.tasks.listTasks(jobId);
  }

  @Sse(':jobId/tasks/realtime')
  streamTasks(
    @CurrentUser() user: User,
    @Param('jobId', ParseUUIDPipe) jobId: string,
  ): Observable<MessageEvent> {
    return sseObservable(() =>
      this.realtime.openSubscription({ model: 'tasks', user, filter: { jobId } }),
    );
  }

  /** The pending queue (sent, not yet consumed) — the composer's pending zone. */
  @Get(':jobId/inbound')
  async listInbound(@Param('jobId', ParseUUIDPipe) jobId: string): Promise<InboundMessageView[]> {
    await this.jobs.assertAccess(jobId);
    return this.live.listPendingInbound(jobId);
  }

  @Sse(':jobId/inbound/realtime')
  streamInbound(
    @CurrentUser() user: User,
    @Param('jobId', ParseUUIDPipe) jobId: string,
  ): Observable<MessageEvent> {
    return sseObservable(() =>
      this.realtime.openSubscription({ model: 'inbound_messages', user, filter: { jobId } }),
    );
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
