import { EnvService } from '@core/config/env/env.service';
import { Global, Module } from '@nestjs/common';
import { ENGINE_RUNNER, EngineModule, EngineRunner } from '../engine';
import { CONTAINER_ENGINE } from './container-engine.port';
import { DockerodeContainerEngine } from './dockerode-container-engine';
import { DockerEngineRunner } from './docker-engine-runner';
import { LocalSandboxProvider } from './local-sandbox.provider';
import { SandboxImageBuilder } from './sandbox-image.builder';
import { SandboxManager } from './sandbox-manager.service';
import { SandboxRefsService } from './sandbox-refs.service';
import { SANDBOX_PROVIDER } from './sandbox-provider.port';

/**
 * The Atlas v2 SANDBOX module — the Docker execution layer, bound behind two @Global ports so the
 * brain / driver / auto-fix / gate consume them with zero per-mode branching:
 *  - `ENGINE_RUNNER`: `EngineRunner` (in-process, default) or `DockerEngineRunner` (exec in a sandbox);
 *  - `SANDBOX_PROVIDER`: `LocalSandboxProvider` (no-op) or `SandboxManager` (per-feature container).
 *
 * The selection is `ATLAS_SANDBOX_MODE` ('local' default → byte-identical to pre-Docker behavior;
 * 'docker' → containerized). Both `ENGINE_RUNNER` factories INJECT the concrete `EngineRunner`, so a
 * test that `overrideProvider(EngineRunner)` (e.g. the e2e fake engine) still flows through in local
 * mode. `CONTAINER_ENGINE` + builder + manager are always provided (construction is cheap and lazy —
 * `dockerode` connects on first use), so nothing requires Docker unless docker mode is selected.
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
    LocalSandboxProvider,
    {
      provide: ENGINE_RUNNER,
      inject: [EnvService, EngineRunner, DockerEngineRunner],
      useFactory: (env: EnvService, local: EngineRunner, docker: DockerEngineRunner) =>
        env.get('ATLAS_SANDBOX_MODE') === 'docker' ? docker : local,
    },
    {
      provide: SANDBOX_PROVIDER,
      inject: [EnvService, LocalSandboxProvider, SandboxManager],
      useFactory: (env: EnvService, local: LocalSandboxProvider, docker: SandboxManager) =>
        env.get('ATLAS_SANDBOX_MODE') === 'docker' ? docker : local,
    },
  ],
  exports: [ENGINE_RUNNER, SANDBOX_PROVIDER, CONTAINER_ENGINE, SandboxRefsService],
})
export class SandboxModule {}
