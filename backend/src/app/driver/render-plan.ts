import type { PlannedPhase } from './planner-llm';

/**
 * Render an ordered phase list as the human-readable section plan stored on `sections.plan` and posted
 * for visibility. Shared by the driver (JIT path) and the brain store (phases authored up front at
 * `submit_plan` time) so both produce byte-identical plan prose — `section.plan` is single-source.
 */
export function renderPlan(phases: PlannedPhase[]): string {
  return phases.map((p, i) => `${i + 1}. **${p.title}** — ${p.brief}`).join('\n');
}
