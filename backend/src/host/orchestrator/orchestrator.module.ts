import { CreateModule } from '@workspace/nestjs-core';
import { JitHostModule } from '../jit/jit-host.module';
import { SandboxModule } from '../sandbox/sandbox.module';
import { WorkspaceProfileModule } from '../workspace-profile/workspace-profile.module';
import { OrchestratorService } from './orchestrator.service';

/**
 * Future-stub host-side turn orchestrator. Imports JitModule (JitRegistry), SandboxModule, and
 * WorkspaceProfileModule and injects their services directly. No turn loop yet.
 */
@CreateModule({
  imports: [JitHostModule, SandboxModule, WorkspaceProfileModule],
  services: [OrchestratorService],
})
export class OrchestratorModule {}
