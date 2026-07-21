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
  services: [JobBootstrapService, JobReconcileService],
  controllers: [JobBootstrapController],
})
export class JobBootstrapModule {}
