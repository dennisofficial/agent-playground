import { Injectable, OnModuleInit } from '@nestjs/common';
import type { ThreadGroupKindSpec } from './__tests__/spec';
import { threadGroupKindSpec, validateThreadGroupKinds } from './registry';

/**
 * thread-group-kind / ThreadGroupKindRegistry — the DI facade over the pure registry, boot-validated LOUD
 * (mirrors `ThreadKindRegistry`). Injectable so the driver + surface can resolve a `ThreadGroupKindSpec` by
 * kind; the pure `threadGroupKindSpec`/`validateThreadGroupKinds` stay usable in scripts/tests.
 */
@Injectable()
export class ThreadGroupKindRegistry implements OnModuleInit {
  onModuleInit(): void {
    validateThreadGroupKinds(); // boot-loud validation (unknown role ref, duplicate kind, bad cardinality)
  }

  /** Resolve a kind's spec, or throw (an unknown kind is a bug). */
  spec(kind: string): ThreadGroupKindSpec {
    return threadGroupKindSpec(kind);
  }
}
