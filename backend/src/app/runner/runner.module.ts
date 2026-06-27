import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { EngineModule } from '../engine';
import { GitModule } from '../git';
import { DB_CONNECTION } from '../persistence/database.module';
import { StepEntity } from '../persistence/entities';
import { TurnRunnerService } from './turn-runner.service';

/**
 * The Atlas v2 RUNNER module — the local turn-runner that ties the engine and git substrates together
 * (host-only, bypassing v1's daemon-gated SessionRunnerService). Imports the EngineModule (the
 * EngineRunner) and GitModule (so the sandbox/PR services compose alongside it for the gate). The
 * `StepEntity` repository (session-state persistence) comes from the persistence module on the 'atlas'
 * connection. Zero v1 imports.
 */
@Module({
  imports: [
    EngineModule,
    GitModule,
    TypeOrmModule.forFeature([StepEntity], DB_CONNECTION),
  ],
  providers: [TurnRunnerService],
  exports: [TurnRunnerService, EngineModule, GitModule],
})
export class RunnerModule {}
