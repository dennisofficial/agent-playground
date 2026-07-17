import { Injectable, OnModuleInit } from '@nestjs/common';
import type { ThreadKindSpec } from './__tests__/spec';
import { threadKindSpec, validateThreadKinds } from './registry';

@Injectable()
export class ThreadKindRegistry implements OnModuleInit {
  onModuleInit(): void {
    validateThreadKinds(); // boot-loud validation (unknown Agent/laneKind, bad child ref, throwing prompt)
  }

  spec(kind: string): ThreadKindSpec {
    return threadKindSpec(kind);
  }
}
