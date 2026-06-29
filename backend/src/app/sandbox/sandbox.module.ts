import { Global, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { EnvService } from '@core/config/env/env.service';
import { ENGINE_RUNNER, EngineModule } from '../engine';
import { DB_CONNECTION } from '../persistence/database.module';
import { ActiveTurnEntity, ToolExecutionEntity } from '../persistence/entities';
import { TurnRegistry } from './turn-registry.service';
import { TurnWatchdogService } from './turn-watchdog.service';
import { CONTAINER_ENGINE } from './container-engine.port';
import { DockerodeContainerEngine } from './dockerode-container-engine';
import { DockerEngineRunner } from './docker-engine-runner';
import { RedisEngineRunner } from './redis-engine-runner';
import { SandboxImageBuilder } from './sandbox-image.builder';
import { SandboxActivityRegistry } from './sandbox-activity.registry';
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
  imports: [
    EngineModule,
    TypeOrmModule.forFeature([ActiveTurnEntity, ToolExecutionEntity], DB_CONNECTION),
  ],
  providers: [
    { provide: CONTAINER_ENGINE, useClass: DockerodeContainerEngine },
    SandboxImageBuilder,
    SandboxRefsService,
    SandboxActivityRegistry,
    TurnRegistry,
    TurnWatchdogService,
    DockerEngineRunner,
    RedisEngineRunner,
    SandboxManager,
    // ENGINE_TRANSPORT selects the transport: 'pipe' (default) = docker-exec stdin/stdout, 'redis' =
    // durable Redis Streams (restart-survivable). Both run the same in-container EngineCore. See ADR 0001.
    {
      provide: ENGINE_RUNNER,
      useFactory: (env: EnvService, pipe: DockerEngineRunner, redis: RedisEngineRunner) =>
        env.get('ENGINE_TRANSPORT') === 'redis' ? redis : pipe,
      inject: [EnvService, DockerEngineRunner, RedisEngineRunner],
    },
    { provide: SANDBOX_PROVIDER, useExisting: SandboxManager },
  ],
  exports: [
    ENGINE_RUNNER,
    SANDBOX_PROVIDER,
    CONTAINER_ENGINE,
    SandboxRefsService,
    SandboxActivityRegistry,
    TurnRegistry,
    DockerEngineRunner,
  ],
})
export class SandboxModule {}
