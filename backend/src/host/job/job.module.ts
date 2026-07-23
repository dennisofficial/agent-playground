import { CreateModule } from '@workspace/nestjs-core';
import { RLS_CONTEXT, type RlsContextConfig } from '@workspace/nestjs-rls/nest';
import { PgRealtimeModule } from '@workspace/pg-realtime/nest';
import { Job, JobRepo } from '../../_lib/database/entities/job.entity';
import { Subagent, SubagentRepo } from '../../_lib/database/entities/subagent.entity';
import { Task, TaskRepo } from '../../_lib/database/entities/task.entity';
import { ThreadGroup, ThreadGroupRepo } from '../../_lib/database/entities/thread-group.entity';
import {
  ThreadMessage,
  ThreadMessageRepo,
} from '../../_lib/database/entities/thread-message.entity';
import { Thread, ThreadRepo } from '../../_lib/database/entities/thread.entity';
import { HostTransportModule } from '../host-transport/host-transport.module';
import { InboundMessageModule } from '../inbound-message/inbound-message.module';
import { SandboxModule } from '../sandbox/sandbox.module';
import { JobViewService } from './job-view.service';
import { JobController } from './job.controller';
import { buildJobRealtimeModels } from './job.realtime';
import { JobService } from './job.service';
import { LiveStateService } from './live-state.service';
import { MessageService } from './message.service';
import { TaskService } from './task.service';
import { ThreadService } from './thread.service';

@CreateModule({
  imports: [
    PgRealtimeModule.forFeature({
      inject: [RLS_CONTEXT],
      useFactory: (ctx: RlsContextConfig) => buildJobRealtimeModels(ctx.resolveClaims),
    }),
    HostTransportModule,
    InboundMessageModule,
    SandboxModule,
  ],
  entities: [
    { entity: Job, repoClass: JobRepo },
    { entity: ThreadGroup, repoClass: ThreadGroupRepo },
    { entity: Thread, repoClass: ThreadRepo },
    { entity: ThreadMessage, repoClass: ThreadMessageRepo },
    { entity: Subagent, repoClass: SubagentRepo },
    { entity: Task, repoClass: TaskRepo },
  ],
  services: [
    JobViewService,
    JobService,
    ThreadService,
    MessageService,
    TaskService,
    LiveStateService,
  ],
  controllers: [JobController],
})
export class JobModule {}
