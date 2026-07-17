import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { EngineModule } from '../engine/engine.module';
import { GitModule } from '../git/git.module';
import { DB_CONNECTION } from '../persistence/database.module';
import { ThreadEntity } from '../persistence/entities';
import { TurnRunnerService } from './turn-runner.service';

@Module({
  imports: [EngineModule, GitModule, TypeOrmModule.forFeature([ThreadEntity], DB_CONNECTION)],
  providers: [TurnRunnerService],
  exports: [TurnRunnerService, EngineModule, GitModule],
})
export class RunnerModule {}
