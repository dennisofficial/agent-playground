import { Injectable } from '@nestjs/common';
import { JitHostRegistry } from '../jit/jit-host.registry';
import { SandboxService } from '../sandbox/sandbox.service';
import { WorkspaceProfileService } from '../workspace-profile/workspace-profile.service';

/**
 * Host-side turn orchestration — the future v2 "driver" (NOT the in-sandbox `src/engine` build target). It
 * pulls the JIT registry, the sandbox, and the workspace profile together to run a turn. SHELL this pass —
 * it marks where the turn loop will live. JIT dispatch/delivery is deferred until the engine defines the
 * app↔engine (Redis) boundary.
 */
@Injectable()
export class OrchestratorService {
  constructor(
    private readonly jit: JitHostRegistry,
    private readonly sandbox: SandboxService,
    private readonly profile: WorkspaceProfileService,
  ) {}
}
