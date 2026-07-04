/**
 * thread-kind / thread-kind.module — provides `ThreadKindRegistry` (the boot-loud validation facade over
 * the pure registry). `@Global` so the driver, surface, and web read model can inject it. No discovery —
 * the specs are an explicit list assembled by pure functions (mirrors `PromptKitModule`).
 */
import { Global, Module } from '@nestjs/common';
import { ThreadKindRegistry } from './thread-kind.service';

@Global()
@Module({
  providers: [ThreadKindRegistry],
  exports: [ThreadKindRegistry],
})
export class ThreadKindModule {}
