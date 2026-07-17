export interface PlannedStep {
  title: string;
  brief: string;
}

export function renderPlan(steps: PlannedStep[]): string {
  return steps.map((p, i) => `${i + 1}. **${p.title}** — ${p.brief}`).join('\n');
}
