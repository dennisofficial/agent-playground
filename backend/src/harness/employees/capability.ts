import type { z } from 'zod';
import type { EngineSpec } from '../engines/engine-spec';
import type { WorkerMode } from '../engines/worker-engine.port';
import type {
  LifecycleEvent,
  LifecyclePayloads,
} from '../lifecycle/lifecycle.types';
import type { EmployeeContext } from './employee-context';

/**
 * A first-class, per-employee CAPABILITY — a configured engine exposed either as a forced lifecycle
 * hook or a discretionary tool. This is what generalizes the old fixed plan/execute/review triad:
 * self-review (engineers, not Sam), deep research (Nora), etc. are capabilities an employee declares,
 * and membership differs per employee.
 *
 * A capability is DECLARATIVE DATA the employee returns from `capabilities(ctx)` — it names itself,
 * builds its `EngineSpec`, and says how it's triggered. The HOW of a lifecycle capability lives in a
 * DI-injectable `LifecycleHandler` (it needs engines/credentials the employee can't reach), matched
 * to the capability by `name`. A tool capability is bound into the chat allowlist at graph-build time
 * via the generic `EngineToolFactory`.
 */
interface BaseCapability {
  /** Stable name — the LLM-visible tool name (tool kind) or the handler key (lifecycle kind). */
  readonly name: string;
  /** Builds the engine recipe this capability runs on, with the injected context. */
  spec(ctx: EmployeeContext): EngineSpec;
}

/** A capability that fires at a harness lifecycle point (forced). */
export interface LifecycleCapability<
  E extends LifecycleEvent = LifecycleEvent,
> extends BaseCapability {
  readonly trigger: {
    readonly kind: 'lifecycle';
    /** Which stage this hooks. */
    readonly on: E;
    /** blocking = awaited middleware that may transform the payload; async = fire-and-forget. */
    readonly mode: 'blocking' | 'async';
    /** Ordering within an event's hooks (lower runs first). Default 0. */
    readonly order?: number;
    /** Per-hook timeout; on expiry the runner falls back to the prior payload. */
    readonly timeoutMs?: number;
  };
  /** Typed predicate over the event's payload — the hook runs only when it returns true. */
  matcher?: (payload: LifecyclePayloads[E]) => boolean;
}

/** A capability the LLM invokes as a chat tool (discretionary). Opens a real session from `spec`. */
export interface ToolCapability extends BaseCapability {
  readonly trigger: { readonly kind: 'tool' };
  /** The LLM-visible tool description. */
  readonly description: string;
  /** The tool's argument schema. */
  readonly schema: z.ZodTypeAny;
  /** The session mode the tool opens in ('plan' for read-only research). */
  readonly mode: WorkerMode;
}

export type Capability = LifecycleCapability | ToolCapability;

export const isLifecycleCapability = (c: Capability): c is LifecycleCapability =>
  c.trigger.kind === 'lifecycle';
export const isToolCapability = (c: Capability): c is ToolCapability =>
  c.trigger.kind === 'tool';
