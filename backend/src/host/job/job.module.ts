import { CreateModule } from '@dltech/nestjs-core';
import { Job, JobRepo } from '../../_lib/database/entities/job.entity';
import { ThreadGroup, ThreadGroupRepo } from '../../_lib/database/entities/thread-group.entity';
import { Thread, ThreadRepo } from '../../_lib/database/entities/thread.entity';
import { HostTransportModule } from '../host-transport/host-transport.module';
import { InboundMessageModule } from '../inbound-message/inbound-message.module';
import { SandboxModule } from '../sandbox/sandbox.module';
import { JobRealtimeResourcesService } from './job-realtime-resources.service';
import { JobViewService } from './job-view.service';
import { JobController } from './job.controller';
import { JobService } from './job.service';

@CreateModule({
  imports: [HostTransportModule, InboundMessageModule, SandboxModule],
  entities: [
    { entity: Job, repoClass: JobRepo },
    { entity: ThreadGroup, repoClass: ThreadGroupRepo },
    { entity: Thread, repoClass: ThreadRepo },
  ],
  services: [JobViewService, JobService, JobRealtimeResourcesService],
  controllers: [JobController],
})
export class JobModule {}
