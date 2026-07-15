/**
 * prompt-kit / assemble — the PURE fragment-assembly core (no NestJS DI).
 *
 * `PromptService` (DI) and `renderAgentPrompt` (script/test-friendly, no DI) BOTH delegate here, so the
 * discovery-based path and the direct path can never drift. The logic: lift `@Fragment` methods off group
 * instances → validate (fail loud) → filter by agent + condition → sort by order → render → join.
 */
import type { Agent } from './agent';
import type { PromptCtx } from './prompt-ctx';
import { getFragmentMetaMap, type LoadedFragment } from './fragment.decorator';
import { FRAGMENT_GROUPS } from './groups';
import { agentMessage, type AgentMessage } from '../message';

/** Reflect every `@Fragment` method off the given group instances into a flat, render-bound list. */
export function loadFragmentsFromInstances(
  instances: unknown[],
): LoadedFragment[] {
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
        render: (ctx: PromptCtx) =>
          (fn as (c: PromptCtx) => string).call(obj, ctx),
      });
    }
  }
  return loaded;
}

/** Assemble the prompt for `agent` against `ctx`: filter → gate → sort → render → drop-empties → join. */
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

/**
 * Fail LOUDLY on a misconfigured fragment set (repo convention): empty `usedBy`, non-finite `order`, a
 * DUPLICATE order within an agent, or a fragment method that throws on a representative context.
 */
export function validateFragments(fragments: LoadedFragment[]): void {
  const perAgentOrders = new Map<Agent, Map<number, string>>();
  for (const f of fragments) {
    if (!f.meta.usedBy.length) {
      throw new Error(`prompt-kit: fragment "${f.id}" has an empty usedBy.`);
    }
    if (!Number.isFinite(f.meta.order)) {
      throw new Error(
        `prompt-kit: fragment "${f.id}" has a non-finite order (${f.meta.order}).`,
      );
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
  // Best-effort smoke render across every agent × representative ctx — surfaces a throwing fragment early.
  const probes: PromptCtx[] = [
    {},
    { jobKind: 'feature' },
    { jobKind: 'onboarding' },
  ];
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

// ── The one assembly path (no NestJS DI) ──────────────────────────────────────────────────────────────
let cached: LoadedFragment[] | null = null;

/** Build + validate the fragment set once (memoized). Call at boot to fail loudly on a misconfiguration. */
export function primeFragments(): LoadedFragment[] {
  if (!cached) {
    const loaded = loadFragmentsFromInstances(
      FRAGMENT_GROUPS.map((G) => new G()),
    );
    validateFragments(loaded);
    cached = loaded;
  }
  return cached;
}

/**
 * Assemble a system prompt for `agent` against `ctx`. Pure (no DI) — news up the `FRAGMENT_GROUPS` directly, so
 * it works identically in the host process, in scripts, and bundled into the in-container engine. This is THE
 * assembly entry point; `PromptService.generate` just delegates here after priming at boot.
 */
export function renderAgentPrompt(
  agent: Agent,
  ctx: PromptCtx = {},
): AgentMessage {
  return agentMessage(assembleFragments(primeFragments(), agent, ctx));
}

/** Test-only: reset the memoized fragment cache (so a spec can re-prime after mutating the group set). */
export function __resetFragmentCache(): void {
  cached = null;
}
