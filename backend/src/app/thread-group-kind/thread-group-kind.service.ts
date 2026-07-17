import { Injectable, OnModuleInit } from '@nestjs/common';
import type { ThreadGroupKindSpec } from './__tests__/spec';
import { threadGroupKindSpec, validateThreadGroupKinds } from './registry';

@Injectable()
export class ThreadGroupKindRegistry implements OnModuleInit {
  onModuleInit(): void {
    validateThreadGroupKinds(); // boot-loud validation (unknown role ref, duplicate kind, bad cardinality)
  }

  spec(kind: string): ThreadGroupKindSpec {
    return threadGroupKindSpec(kind);
  }
}
