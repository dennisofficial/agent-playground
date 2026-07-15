/**
 * stage-kind / stage-kind.module — provides `StageKindRegistry` (the boot-loud validation facade over the
 * pure registry). `@Global` so the driver, surface, and web read model can inject it. No discovery — the
 * specs are an explicit list assembled by pure functions (mirrors `ThreadKindModule`).
 */
import { Global, Module } from '@nestjs/common';
import { StageKindRegistry } from './stage-kind.service';

@Global()
@Module({
  providers: [StageKindRegistry],
  exports: [StageKindRegistry],
})
export class StageKindModule {}
