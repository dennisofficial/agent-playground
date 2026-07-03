/** One step of a thread's plan (title + the brief an execute turn runs). The build no longer LLM-plans a
 *  multi-step list — a thread locks exactly one step whose brief is the thread brief — but the shape is
 *  kept as the step-render/persistence view shared by the driver + brain store. */
export interface PlannedStep {
  title: string;
  brief: string;
}

/**
 * Render an ordered step list as the human-readable thread plan stored on `threads.plan` and posted
 * for visibility. Shared by the driver (JIT path) and the brain store (steps authored up front at
 * `submit_plan` time) so both produce byte-identical plan prose — `thread.plan` is single-source.
 */
export function renderPlan(steps: PlannedStep[]): string {
  return steps.map((p, i) => `${i + 1}. **${p.title}** — ${p.brief}`).join('\n');
}
