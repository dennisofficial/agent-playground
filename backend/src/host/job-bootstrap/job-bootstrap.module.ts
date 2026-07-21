import { BullModule } from '@nestjs/bullmq';
import { CreateModule } from '@workspace/nestjs-core';
import { InboundMessageModule } from '../inbound-message/inbound-message.module';
import { SandboxModule } from '../sandbox/sandbox.module';
import { TurnModule } from '../turn/turn.module';
import { JobBootstrapController } from './job-bootstrap.controller';
import { JobBootstrapService } from './job-bootstrap.service';
import { SandboxProvisionProcessor } from './sandbox-provision.processor';
import { TurnDispatchProcessor } from './turn-dispatch.processor';
import { TurnRunnerService } from './turn-runner.service';
import { TurnSpecBuilder } from './turn-spec-builder.service';

@CreateModule({
  imports: [InboundMessageModule, TurnModule, SandboxModule, BullModule.registerFlowProducer({})],
  queues: [SandboxProvisionProcessor, TurnDispatchProcessor],
  processors: [SandboxProvisionProcessor, TurnDispatchProcessor],
  services: [JobBootstrapService, TurnRunnerService, TurnSpecBuilder],
  controllers: [JobBootstrapController],
})
export class JobBootstrapModule {}
