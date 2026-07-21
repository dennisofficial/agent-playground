import { CreateModule } from '@workspace/nestjs-core';
import { ProvisionStatusModule } from '../provision-status/provision-status.module';
import { WorkspaceProfileModule } from '../workspace-profile/workspace-profile.module';
import { SandboxProvisionProcessor } from './sandbox-provision.processor';
import { SandboxService } from './sandbox.service';

@CreateModule({
  imports: [WorkspaceProfileModule, ProvisionStatusModule],
  queues: [SandboxProvisionProcessor],
  processors: [SandboxProvisionProcessor],
  // Exported: launchEngineTurn (via TurnModule) also calls ensureReady, so the service can't be module-private.
  services: [SandboxService],
})
export class SandboxModule {}
