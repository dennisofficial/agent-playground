import type { FactoryProvider, InjectionToken } from '@nestjs/common';
import type { ModelConfig } from '@workspace/pg-realtime';

/**
 * Multi-provider token: each feature module contributes the pg-realtime models it owns (its tables,
 * with their guards + mapRow). `RealtimeModule.forRoot` aggregates every contribution into the engine,
 * so `_lib` never imports a feature — the domain knowledge lives with the domain.
 */
export const REALTIME_MODEL = Symbol('REALTIME_MODEL');

/** One feature's contribution — the models it registers. */
export type RealtimeModelContribution = ModelConfig[];

/**
 * Build the multi-provider a feature uses to contribute its realtime models. Wraps the cast for Nest's
 * `FactoryProvider` type, which omits `multi` even though the DI container supports it.
 */
export function realtimeModelProvider(
  useFactory: (...args: any[]) => RealtimeModelContribution,
  inject: InjectionToken[],
): FactoryProvider {
  return { provide: REALTIME_MODEL, useFactory, inject, multi: true } as FactoryProvider;
}
