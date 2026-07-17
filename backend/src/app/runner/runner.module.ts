import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { EngineModule } from '../engine/engine.module';
import { GitModule } from '../git/git.module';
import { DB_CONNECTION } from '../persistence/database.module';
import { ThreadEntity } from '../persistence/entities';
import { TurnRunnerService } from './turn-runner.service';

/**
 * The Atlas v2 RUNNER module — the local turn-runner that ties the engine and git substrates together
 * (host-only, bypassing v1's daemon-gated SessionRunnerService). Imports the EngineModule (the
 * EngineRunner) and GitModule (so the sandbox/PR services compose alongside it for the gate). The
 * `ThreadEntity` repository (session-state persistence — a thread's single step IS the thread row)
 * comes from the persistence module on the 'atlas' connection. Zero v1 imports.
 */
@Module({
  imports: [EngineModule, GitModule, TypeOrmModule.forFeature([ThreadEntity], DB_CONNECTION)],
  providers: [TurnRunnerService],
  exports: [TurnRunnerService, EngineModule, GitModule],
})
export class RunnerModule {}
