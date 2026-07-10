/**
 * prompt-kit / fragment.decorator — the `@FragmentGroup` / `@Fragment` decorators + their metadata reflection.
 *
 * A FRAGMENT is a small, annotated block of prompt text. Fragments are METHODS on topic-bucketed
 * `@FragmentGroup()` classes (see `groups/`). `PromptService` discovers the group providers at boot
 * (DiscoveryService), reflects each group's `@Fragment` methods into a flat list, then filters by
 * `usedBy` + `condition` and sorts by `order` to assemble a prompt.
 *
 *  - `@FragmentGroup()` — a plain class MARKER (no `@nestjs/core` dependency, so this code bundles into the
 *    in-container engine without dragging NestJS in). Groups are enumerated by the explicit `FRAGMENT_GROUPS`
 *    list (`groups/index.ts`), not by runtime discovery.
 *  - `@Fragment({ usedBy, order, condition? })` — a method decorator. It records `{ methodName → meta }` in a
 *    single Reflect metadata map on the class PROTOTYPE (not on the function object), which `getFragmentMetaMap`
 *    reads back. This avoids `MetadataScanner` and is robust to method wrapping.
 */
import type { Agent } from './agent';
import type { PromptCtx } from './prompt-ctx';

/** A no-op class marker documenting a fragment group. Groups are enumerated via `FRAGMENT_GROUPS`. */
export function FragmentGroup(): ClassDecorator {
  return () => undefined;
}

/** A fragment renders to a string from the context (static fragments simply ignore `ctx`). */
export type FragmentRender = (ctx: PromptCtx) => string;

export interface FragmentMeta {
  /** Which agents this fragment is addressed to. Empty is a boot error. */
  usedBy: Agent[];
  /** Global sort key WITHIN an agent — a bare number applies to every audience, or a per-audience map.
   *  Must resolve to a finite, unique order per used-by agent (enforced at boot). */
  order: number | Partial<Record<Agent, number>>;
  /** Optional gate: the fragment is included only when this returns true (default: always). */
  condition?: (ctx: PromptCtx) => boolean;
}

/**
 * A group prototype → its `{ methodName → FragmentMeta }` map. A plain `WeakMap` (NOT `reflect-metadata`) so
 * this library has ZERO runtime dependencies and bundles cleanly into the in-container engine.
 */
const FRAGMENT_META = new WeakMap<object, Record<string, FragmentMeta>>();

/**
 * Mark a group METHOD as a fragment. The method is the render function `(ctx) => string`; the decorator records
 * its `FragmentMeta` against the class prototype so the assembler can lift it later.
 */
export function Fragment(meta: FragmentMeta): MethodDecorator {
  return (target, propertyKey) => {
    const existing = FRAGMENT_META.get(target) ?? {};
    existing[propertyKey as string] = meta;
    FRAGMENT_META.set(target, existing);
  };
}

/** Read a group instance's `{ methodName → FragmentMeta }` map (empty if none). Pass the instance's prototype. */
export function getFragmentMetaMap(proto: object): Record<string, FragmentMeta> {
  return FRAGMENT_META.get(proto) ?? {};
}

/** A fragment lifted off a group at boot: its render fn (bound to the instance) plus its metadata. */
export interface LoadedFragment {
  /** `<GroupClass>.<method>` — for boot-validation error messages. */
  id: string;
  meta: FragmentMeta;
  render: FragmentRender;
}
