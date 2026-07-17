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
