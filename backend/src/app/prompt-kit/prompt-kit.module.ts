/**
 * prompt-kit / prompt-kit.module — provides `PromptService` (the boot-loud validation facade over the pure
 * assembly core). `@Global` so any consumer (the brain, the test-bridge preview) can inject it. No
 * `DiscoveryModule` and no group providers — fragments are enumerated via the explicit `FRAGMENT_GROUPS`
 * list and assembled by pure functions, so nothing here needs runtime discovery.
 */
import { Global, Module } from '@nestjs/common';
import { PromptService } from './prompt.service';

@Global()
@Module({
  providers: [PromptService],
  exports: [PromptService],
})
export class PromptKitModule {}
