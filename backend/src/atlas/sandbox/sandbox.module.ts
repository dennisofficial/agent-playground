import { Global, Module } from '@nestjs/common';
import { ENGINE_RUNNER, EngineModule } from '../engine';
import { CONTAINER_ENGINE } from './container-engine.port';
import { DockerodeContainerEngine } from './dockerode-container-engine';
import { DockerEngineRunner } from './docker-engine-runner';
import { SandboxImageBuilder } from './sandbox-image.builder';
import { SandboxManager } from './sandbox-manager.service';
import { SandboxRefsService } from './sandbox-refs.service';
import { SANDBOX_PROVIDER } from './sandbox-provider.port';

/**
 * The Atlas v2 SANDBOX module — the Docker execution layer, bound behind two @Global ports so the
 * brain / driver / auto-fix / gate consume them with zero per-mode branching:
 *  - `ENGINE_RUNNER`: always `DockerEngineRunner` — every engine turn executes inside a sandbox
 *    container via `docker exec`.
 *  - `SANDBOX_PROVIDER`: always `SandboxManager` — a long-lived, network-isolated, privileged
 *    per-feature container is provisioned for every job.
 *
 * Docker is the ONLY execution mode. The former `local` in-process path (EngineRunner,
 * LocalSandboxProvider) has been deleted. `CONTAINER_ENGINE` + builder + manager connect to
 * Docker lazily on first use, so module construction does not require a running daemon.
 *
 * Imported once by the app composition root; @Global so the tokens resolve everywhere. Zero v1 imports.
 */
@Global()
@Module({
  imports: [EngineModule],
  providers: [
    { provide: CONTAINER_ENGINE, useClass: DockerodeContainerEngine },
    SandboxImageBuilder,
    SandboxRefsService,
    DockerEngineRunner,
    SandboxManager,
    { provide: ENGINE_RUNNER, useExisting: DockerEngineRunner },
    { provide: SANDBOX_PROVIDER, useExisting: SandboxManager },
  ],
  exports: [ENGINE_RUNNER, SANDBOX_PROVIDER, CONTAINER_ENGINE, SandboxRefsService, DockerEngineRunner],
})
export class SandboxModule {}
