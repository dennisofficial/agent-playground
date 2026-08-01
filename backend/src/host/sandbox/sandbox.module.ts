import { CreateModule } from '@dltech/nestjs-core';
import { HostTransportModule } from '../host-transport/host-transport.module';
import { ProvisionStatusModule } from '../provision-status/provision-status.module';
import { WorkspaceProfileModule } from '../workspace-profile/workspace-profile.module';
import { SandboxProvisionProcessor } from './sandbox-provision.processor';
import { SandboxService } from './sandbox.service';

@CreateModule({
  imports: [WorkspaceProfileModule, ProvisionStatusModule, HostTransportModule],
  queues: [SandboxProvisionProcessor],
  processors: [SandboxProvisionProcessor],
  services: [SandboxService],
})
export class SandboxModule {}
