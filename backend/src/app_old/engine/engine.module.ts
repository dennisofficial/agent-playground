import { Module } from '@nestjs/common';
import { EngineEsmModule } from './esm.module';

@Module({
  imports: [EngineEsmModule],
  providers: [],
  exports: [],
})
export class EngineModule {}
