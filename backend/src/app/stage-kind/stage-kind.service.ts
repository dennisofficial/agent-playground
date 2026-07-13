import { Injectable, OnModuleInit } from '@nestjs/common';
import { stageKindSpec, validateStageKinds } from './registry';
import type { StageKindSpec } from './spec';

/**
 * stage-kind / StageKindRegistry — the DI facade over the pure registry, boot-validated LOUD (mirrors
 * `ThreadKindRegistry`). Injectable so the driver + surface can resolve a `StageKindSpec` by kind; the pure
 * `stageKindSpec`/`validateStageKinds` stay usable in scripts/tests.
 */
@Injectable()
export class StageKindRegistry implements OnModuleInit {
  onModuleInit(): void {
    validateStageKinds(); // boot-loud validation (unknown role ref, duplicate kind, bad cardinality)
  }

  /** Resolve a kind's spec, or throw (an unknown kind is a bug). */
  spec(kind: string): StageKindSpec {
    return stageKindSpec(kind);
  }
}
