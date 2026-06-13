import type { EngineSpec } from '../engines/engine-spec';
import type {
  LifecycleEvent,
  LifecyclePayloads,
  LifecycleResult,
} from './lifecycle.types';

/** DI token collecting every registered lifecycle handler (the runner fans capabilities to them). */
export const LIFECYCLE_HANDLERS = Symbol('LIFECYCLE_HANDLERS');

/**
 * The HOW behind a lifecycle capability. Capabilities are declarative data the employee returns; the
 * behavior that needs engines/credentials lives here, in a DI-injectable handler matched to a
 * capability by `capability` name. A blocking handler returns a partial that the runner applies
 * through the event's transform contract; an async handler's return is ignored.
 */
export interface LifecycleHandler {
  /** The `Capability.name` this handler implements (e.g. 'self_review'). */
  readonly capability: string;
  /**
   * Run the hook. `payload` is the event's payload (the runner gates by `event`); a blocking handler
   * returns a partial the runner applies through the transform contract, or void to no-op. Typed over
   * the union (not generic) so concrete handlers and test doubles can return concrete partials.
   */
  handle(
    event: LifecycleEvent,
    payload: LifecyclePayloads[LifecycleEvent],
    spec: EngineSpec,
  ): Promise<LifecycleResult<LifecycleEvent>>;
}
