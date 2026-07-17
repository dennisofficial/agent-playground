import { Global, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ENGINE_RUNNER } from '@shared/engine';
import { EngineModule } from '../engine/engine.module';
import { DB_CONNECTION } from '../persistence/database.module';
import { ActiveTurnEntity, ToolExecutionEntity } from '../persistence/entities';
import { CONTAINER_ENGINE } from './container-engine.port';
import { DockerodeContainerEngine } from './dockerode-container-engine';
import { RedisEngineRunner } from './redis-engine-runner';
import { SandboxActivityRegistry } from './sandbox-activity.registry';
import { SandboxImageBuilder } from './sandbox-image.builder';
import { SandboxManager } from './sandbox-manager.service';
import { SANDBOX_PROVIDER } from './sandbox-provider.port';
import { SandboxRefsService } from './sandbox-refs.service';
import { TurnReattachRegistry } from './turn-reattach.registry';
import { TurnRegistry } from './turn-registry.service';
import { TurnStreamReaperService } from './turn-stream-reaper.service';
import { TurnWatchdogService } from './turn-watchdog.service';

/**
 * The Atlas v2 SANDBOX module — the Docker execution layer, bound behind two @Global ports so the
 * brain / driver / auto-fix / gate consume them with zero per-mode branching:
 *  - `ENGINE_RUNNER`: `RedisEngineRunner` — every engine turn runs inside a sandbox via a DETACHED
 *    `docker exec` and talks to the host over durable Redis Streams (restart-survivable). The former
 *    pipe transport (`DockerEngineRunner`, stdin/stdout NDJSON) was removed at the redis cutover (ADR 0001).
 *  - `SANDBOX_PROVIDER`: always `SandboxManager` — a long-lived, network-isolated, privileged
 *    per-feature container is provisioned for every job.
 *
 * `CONTAINER_ENGINE` + builder + manager connect to Docker lazily on first use, so module construction
 * does not require a running daemon. Imported once by the app composition root; @Global so the tokens
 * resolve everywhere. Zero v1 imports.
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
    TurnReattachRegistry,
    TurnWatchdogService,
    TurnStreamReaperService,
    RedisEngineRunner,
    SandboxManager,
    { provide: ENGINE_RUNNER, useExisting: RedisEngineRunner },
    { provide: SANDBOX_PROVIDER, useExisting: SandboxManager },
  ],
  exports: [
    ENGINE_RUNNER,
    SANDBOX_PROVIDER,
    CONTAINER_ENGINE,
    SandboxRefsService,
    SandboxActivityRegistry,
    TurnRegistry,
    TurnReattachRegistry,
    RedisEngineRunner,
  ],
})
export class SandboxModule {}
