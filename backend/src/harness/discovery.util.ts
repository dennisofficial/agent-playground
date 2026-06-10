import type { Type } from '@nestjs/common';
import { DiscoveryService } from '@nestjs/core';

/**
 * Collect every registered provider instance whose CLASS carries `metadataKey` (set by a marker
 * decorator like `@AIEmployee()` / `@HarnessTool()`).
 *
 * Constraint this imposes on modules: decorated classes must be registered as PLAIN CLASS providers
 * (`providers: [AlexEmployee]`) — `useFactory`/`useValue` providers have no `metatype`, so discovery
 * cannot see their decorator metadata. Registries built on this fail loudly at boot instead.
 */
export function collectDecorated<T>(
  discovery: DiscoveryService,
  metadataKey: symbol,
): Array<{ instance: T; metatype: Type }> {
  const seen = new Set<Type>();
  const found: Array<{ instance: T; metatype: Type }> = [];
  for (const wrapper of discovery.getProviders()) {
    const metatype = wrapper.metatype as Type | undefined;
    if (!metatype || typeof metatype !== 'function' || !wrapper.instance)
      continue;
    if (!Reflect.getMetadata(metadataKey, metatype)) continue;
    if (seen.has(metatype)) continue; // the same class can appear in several module scopes — one entry
    seen.add(metatype);
    found.push({ instance: wrapper.instance as T, metatype });
  }
  return found;
}
