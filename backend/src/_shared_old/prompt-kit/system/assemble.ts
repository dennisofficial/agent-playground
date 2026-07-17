import { agentMessage, type AgentMessage } from '../message';
import type { Agent } from './agent';
import { getFragmentMetaMap, type LoadedFragment } from './fragment.decorator';
import { FRAGMENT_GROUPS } from './groups';
import type { PromptCtx } from './prompt-ctx';

export function loadFragmentsFromInstances(instances: unknown[]): LoadedFragment[] {
  const loaded: LoadedFragment[] = [];
  for (const instance of instances) {
    if (!instance || typeof instance !== 'object') continue;
    const obj = instance as Record<string, unknown>;
    const proto = Object.getPrototypeOf(obj) as object;
    const metaMap = getFragmentMetaMap(proto);
    for (const [method, meta] of Object.entries(metaMap)) {
      const fn = obj[method];
      if (typeof fn !== 'function') {
        throw new Error(
          `prompt-kit: @Fragment "${obj.constructor.name}.${method}" is not a method.`,
        );
      }
      loaded.push({
        id: `${obj.constructor.name}.${method}`,
        meta,
        render: (ctx: PromptCtx) => (fn as (c: PromptCtx) => string).call(obj, ctx),
      });
    }
  }
  return loaded;
}

export function assembleFragments(
  fragments: LoadedFragment[],
  agent: Agent,
  ctx: PromptCtx,
): string {
  return fragments
    .filter((f) => f.meta.usedBy.includes(agent))
    .filter((f) => f.meta.condition?.(ctx) ?? true)
    .sort((a, b) => a.meta.order - b.meta.order)
    .map((f) => f.render(ctx).trim())
    .filter((s) => s.length > 0)
    .join('\n\n');
}

export function validateFragments(fragments: LoadedFragment[]): void {
  const perAgentOrders = new Map<Agent, Map<number, string>>();
  for (const f of fragments) {
    if (!f.meta.usedBy.length) {
      throw new Error(`prompt-kit: fragment "${f.id}" has an empty usedBy.`);
    }
    if (!Number.isFinite(f.meta.order)) {
      throw new Error(`prompt-kit: fragment "${f.id}" has a non-finite order (${f.meta.order}).`);
    }
    for (const agent of f.meta.usedBy) {
      const seen = perAgentOrders.get(agent) ?? new Map<number, string>();
      const clash = seen.get(f.meta.order);
      if (clash) {
        throw new Error(
          `prompt-kit: duplicate order ${f.meta.order} for agent "${agent}" — "${clash}" and "${f.id}".`,
        );
      }
      seen.set(f.meta.order, f.id);
      perAgentOrders.set(agent, seen);
    }
  }
  const probes: PromptCtx[] = [{}, { jobKind: 'feature' }, { jobKind: 'onboarding' }];
  for (const agent of new Set(fragments.flatMap((f) => f.meta.usedBy))) {
    for (const ctx of probes) {
      try {
        assembleFragments(fragments, agent, ctx);
      } catch (err) {
        throw new Error(
          `prompt-kit: fragment threw while assembling agent "${agent}" @ ${JSON.stringify(ctx)}: ${
            (err as Error).message
          }`,
        );
      }
    }
  }
}

let cached: LoadedFragment[] | null = null;

export function primeFragments(): LoadedFragment[] {
  if (!cached) {
    const loaded = loadFragmentsFromInstances(FRAGMENT_GROUPS.map((G) => new G()));
    validateFragments(loaded);
    cached = loaded;
  }
  return cached;
}

export function renderAgentPrompt(agent: Agent, ctx: PromptCtx = {}): AgentMessage {
  return agentMessage(assembleFragments(primeFragments(), agent, ctx));
}

export function __resetFragmentCache(): void {
  cached = null;
}
