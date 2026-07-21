import { BullModule } from '@nestjs/bullmq';
import { CreateModule } from '@workspace/nestjs-core';
import { InboundMessageModule } from '../inbound-message/inbound-message.module';
import { SandboxModule } from '../sandbox/sandbox.module';
import { TurnModule } from '../turn/turn.module';
import { WorkspaceFsModule } from '../workspace-fs/workspace-fs.module';
import { JobBootstrapController } from './job-bootstrap.controller';
import { JobBootstrapService } from './job-bootstrap.service';
import { JobReconcileService } from './job-reconcile.service';
import { TurnDispatchProcessor } from './turn-dispatch.processor';
import { TurnSpecBuilder } from './turn-spec-builder.service';

// Imports SandboxModule + WorkspaceFsModule so their provision workers join the app graph (their queues are
// registered in their own modules now); the flow producer here enqueues to all three stages by queue name.
@CreateModule({
  imports: [
    InboundMessageModule,
    TurnModule,
    SandboxModule,
    WorkspaceFsModule,
    BullModule.registerFlowProducer({}),
  ],
  queues: [TurnDispatchProcessor],
  processors: [TurnDispatchProcessor],
  services: [JobBootstrapService, JobReconcileService, TurnSpecBuilder],
  controllers: [JobBootstrapController],
})
export class JobBootstrapModule {}
