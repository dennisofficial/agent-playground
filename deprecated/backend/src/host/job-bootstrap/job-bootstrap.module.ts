import { PgbaseModule } from '@lib/pgbase/pgbase.module';
import { BullModule } from '@nestjs/bullmq';
import { CreateModule } from '@dltech/nestjs-core';
import { InboundMessageModule } from '../inbound-message/inbound-message.module';
import { SandboxModule } from '../sandbox/sandbox.module';
import { TurnModule } from '../turn/turn.module';
import { WorkspaceFsModule } from '../workspace-fs/workspace-fs.module';
import { IntakeService } from './intake.service';
import { JobBootstrapController } from './job-bootstrap.controller';
import { JobBootstrapService } from './job-bootstrap.service';
import { JobReconcileService } from './job-reconcile.service';
import { TurnDispatchProcessor } from './turn-dispatch.processor';
import { TurnFlowService } from './turn-flow.service';

@CreateModule({
  imports: [
    InboundMessageModule,
    TurnModule,
    SandboxModule,
    WorkspaceFsModule,
    BullModule.registerFlowProducer({}),
    // Exports ScopedDb, which JobBootstrapService injects for the Repo access-check + Job read.
    PgbaseModule,
  ],
  queues: [TurnDispatchProcessor],
  processors: [TurnDispatchProcessor],
  services: [IntakeService, JobBootstrapService, JobReconcileService, TurnFlowService],
  controllers: [JobBootstrapController],
})
export class JobBootstrapModule {}
