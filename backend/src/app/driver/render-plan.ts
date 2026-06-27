import type { PlannedStep } from './planner-llm';

/**
 * Render an ordered step list as the human-readable track plan stored on `tracks.plan` and posted
 * for visibility. Shared by the driver (JIT path) and the brain store (steps authored up front at
 * `submit_plan` time) so both produce byte-identical plan prose — `track.plan` is single-source.
 */
export function renderPlan(steps: PlannedStep[]): string {
  return steps.map((p, i) => `${i + 1}. **${p.title}** — ${p.brief}`).join('\n');
}
