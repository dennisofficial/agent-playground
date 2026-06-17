import type { EngineSpec } from '../../engines/engine-spec';
import { LifecycleEvent } from '../../lifecycle/lifecycle.types';
import type { LifecycleCapability } from '../capability';
import type { EmployeeContext } from '../employee-context';

/** Capability name — also the key the `SelfReviewHandler` registers under (see lifecycle wiring). */
export const SELF_REVIEW = 'self_review';

/**
 * The forced, one-shot plan self-review: when a planning turn finishes, a SECOND engine adversarially
 * critiques the plan and the planning engine revises ONCE before the plan relays back to the employee.
 * Declared only by employees that should self-review; non-builder employees omit it.
 *
 * The `spec` is the REVIEW engine recipe — typically a different engine than the planner (cross-engine
 * independence), built by the employee via `this.engineSpec(ctx, REVIEW_*)`. Blocking with no timeout
 * (best-effort: the runner isolates a failure and keeps the un-reviewed plan).
 */
export const selfReviewCapability = (
  spec: (ctx: EmployeeContext) => EngineSpec,
): LifecycleCapability => ({
  name: SELF_REVIEW,
  spec,
  trigger: {
    kind: 'lifecycle',
    on: LifecycleEvent.PlanFinished,
    mode: 'blocking',
  },
});
