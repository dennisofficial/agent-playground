import type { EngineSpec } from '../engines/engine-spec';
import type { WorkerMode } from '../engines/worker-engine.port';
import type { EmployeeContext } from './employee-context';
import type { EmployeeDefinition } from './employee.types';

/**
 * Resolve the engine recipe (engine + model + effort + system prompt) for a session turn's mode. The
 * SINGLE source of truth for the mode→spec mapping: every consumer (the session runner's turn, its
 * reply-session engine guard, and `check_session`'s tier display) routes through here so they can't
 * drift back to the old "non-plan = execute" assumption that silently treated `investigate` as
 * `execute`.
 */
export function engineSpecForMode(
  emp: EmployeeDefinition,
  ctx: EmployeeContext,
  mode: WorkerMode,
): EngineSpec {
  return mode === 'plan'
    ? emp.planEngine(ctx)
    : mode === 'investigate'
      ? emp.investigateEngine(ctx)
      : emp.executeEngine(ctx);
}
