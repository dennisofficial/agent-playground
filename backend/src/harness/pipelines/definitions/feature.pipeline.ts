import { PipelineDefinition } from '../pipeline.types';

/**
 * Standard feature-development pipeline. Walks a ticket from planning through backend
 * implementation, investigative review, frontend implementation, design validation, and
 * finally a gate-gated PR-ready publish.
 *
 * Stage roles reference employee ids as declared in the roster (alex, riley, maya, …).
 */
export const featurePipeline: PipelineDefinition = {
  name: 'feature',
  description:
    'Full-stack feature: plan → backend → review → frontend → design validation → publish PR',
  stages: [
    // Lead signs off on the technical plan before any code is written.
    { role: 'alex', mode: 'plan', gate: 'plan' },
    // Backend engineer implements the planned work.
    { role: 'alex', mode: 'execute' },
    // Self-review: investigate for regressions, edge cases, and quality issues.
    { role: 'alex', mode: 'investigate' },
    // Frontend engineer builds the UI against the new backend.
    { role: 'riley', mode: 'execute' },
    // Designer reviews the shipped UI for visual and UX correctness.
    { role: 'maya', mode: 'investigate' },
    // Frontend engineer addresses design feedback.
    { role: 'riley', mode: 'execute' },
    // Final publish: opens the PR and marks it ready for Dennis's review.
    { role: 'riley', mode: 'execute', gate: 'pr' },
  ],
};
