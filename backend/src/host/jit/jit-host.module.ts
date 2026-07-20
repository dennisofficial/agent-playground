import { DiscoveryModule } from '@nestjs/core';
import { CreateModule } from '@workspace/nestjs-core';
import { JitHostRegistry } from './jit-host.registry';

/**
 * The general JIT framework — domain-agnostic. It imports Nest's `DiscoveryModule` so `JitRegistry` can find
 * `@JitHook`-annotated providers ANYWHERE in the app without importing their modules (deps invert via
 * discovery). Feature modules do NOT import this module — they only import the decorator from `_shared/jit`.
 *
 * Dispatch + delivery (routing a fired hook's output into a turn) is deferred until the engine exists — its
 * shape depends on the app↔engine (Redis) boundary, so there's nothing to abstract yet.
 */
@CreateModule({
  imports: [DiscoveryModule],
  services: [JitHostRegistry], // exported
})
export class JitHostModule {}
