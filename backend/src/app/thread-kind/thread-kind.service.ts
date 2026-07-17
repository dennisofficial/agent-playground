import { Injectable, OnModuleInit } from '@nestjs/common';
import { threadKindSpec, validateThreadKinds } from './registry';
import type { ThreadKindSpec } from './__tests__/spec';

/**
 * thread-kind / ThreadKindRegistry — the DI facade over the pure registry, boot-validated LOUD (the twin
 * of `PromptService.onModuleInit → primeFragments`). Injectable so the driver + surface can resolve a
 * `ThreadKindSpec` by kind; the pure `threadKindSpec`/`validateThreadKinds` stay usable in scripts/tests.
 */
@Injectable()
export class ThreadKindRegistry implements OnModuleInit {
  onModuleInit(): void {
    validateThreadKinds(); // boot-loud validation (unknown Agent/laneKind, bad child ref, throwing prompt)
  }

  /** Resolve a kind's spec, or throw (an unknown kind is a bug). */
  spec(kind: string): ThreadKindSpec {
    return threadKindSpec(kind);
  }
}
