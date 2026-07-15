/**
 * thread-group-kind / thread-group-kind.module — provides `ThreadGroupKindRegistry` (the boot-loud
 * validation facade over the pure registry). `@Global` so the driver, surface, and web read model can
 * inject it. No discovery — the specs are an explicit list assembled by pure functions (mirrors
 * `ThreadKindModule`).
 */
import { Global, Module } from '@nestjs/common';
import { ThreadGroupKindRegistry } from './thread-group-kind.service';

@Global()
@Module({
  providers: [ThreadGroupKindRegistry],
  exports: [ThreadGroupKindRegistry],
})
export class ThreadGroupKindModule {}
