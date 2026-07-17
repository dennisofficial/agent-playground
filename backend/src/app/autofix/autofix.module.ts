import { Module } from '@nestjs/common';
import { EngineModule } from '../engine/engine.module';
import { GitModule } from '../git/git.module';
import { AutoFixStage } from './autofix.stage';

@Module({
  imports: [EngineModule, GitModule],
  providers: [AutoFixStage],
  exports: [AutoFixStage],
})
export class AutoFixModule {}
