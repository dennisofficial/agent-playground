import { PgbaseModule } from '@lib/pgbase/pgbase.module';
import { CreateModule } from '@dltech/nestjs-core';
import { HostTransportModule } from '../host-transport/host-transport.module';
import { InboundMessageModule } from '../inbound-message/inbound-message.module';
import { SandboxModule } from '../sandbox/sandbox.module';
import { JobRealtimeResourcesService } from './job-realtime-resources.service';
import { JobViewService } from './job-view.service';
import { JobController } from './job.controller';
import { JobService } from './job.service';

@CreateModule({
  imports: [
    HostTransportModule,
    InboundMessageModule,
    SandboxModule,
    // Exports ScopedDb, which JobService injects for every Job/ThreadGroup/Thread read + Job write.
    PgbaseModule,
  ],
  services: [JobViewService, JobService, JobRealtimeResourcesService],
  controllers: [JobController],
})
export class JobModule {}
