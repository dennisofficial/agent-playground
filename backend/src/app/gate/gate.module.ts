import { Module } from '@nestjs/common';
import { RunnerModule } from '../runner';
import { SandboxModule } from '../sandbox';
import { AcceptanceGateService } from './acceptance-gate.service';

/**
 * The W1 acceptance-GATE module — composes the substrate the gate exercises and provides
 * `AcceptanceGateService`:
 *  - `RunnerModule` → re-exports `GitModule` (`LocalGitService` + `GithubPrService`);
 *  - `SandboxModule` (@Global) → binds the `ENGINE_RUNNER` + `SANDBOX_PROVIDER` ports the gate injects.
 *
 * Surface-free: the gate proves clone → engine turn → commit → PR with no chat posting, so it does NOT
 * import `SurfaceModule` (which would pull in the web surface + its brain/driver deps that
 * `GateRootModule` doesn't provide). Zero v1 imports.
 */
@Module({
  imports: [RunnerModule, SandboxModule],
  providers: [AcceptanceGateService],
  exports: [AcceptanceGateService],
})
export class GateModule {}
