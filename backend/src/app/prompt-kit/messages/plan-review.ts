import type { Decision } from '@shared/domain';
import { agentMessage, type AgentMessage } from '@shared/prompt-kit/message';
import type { PlannedStep } from './render-plan';

/**
 * prompt-kit / messages / plan-review — the synchronous Codex plan-review task bodies: the first-round
 * review (intent → authored plan → judge) and the resumed re-review (adjudicate prior findings against
 * the revised specs). `PlanReviewService` (`brain/plan-review.service.ts`) owns the RUNTIME (dispatch,
 * resume, persistence) — this file owns only the agent-facing TEXT.
 */

/** What `review` needs to render the review task (orientation; the specs on disk are authoritative). */
export type PlanReviewInput = {
  jobId: string;
  orgId: string;
  goal: string;
  overview: string;
  decisions: Decision[];
  threadTitles: string[];
  stepsByThread?: PlannedStep[][];
  /** On a RESUME (re-review): what Atlas changed / a point-by-point pushback. Ignored on the first run. */
  note?: string;
};

/**
 * Render the `<intent>` block shared by the first-round review task and `plan-review.eval.ts`'s stand-in
 * reviewer task — the operator's GOAL (falling back to the overview when unset) + the overview. Single
 * source so the eval's calibration harness can never drift from what the real review turn actually reads.
 */
export function renderReviewIntent(input: { goal: string; overview: string }): string {
  const intent = [
    '<intent>',
    'What the operator is trying to achieve. Judge the plan against THIS — not your own idea of the feature.',
    '',
    `GOAL: ${input.goal || '(see overview)'}`,
  ];
  intent.push('', "OVERVIEW (Atlas's framing of the work):", input.overview, '</intent>');
  return intent.join('\n');
}

/** Render the structured review task: the operator's INTENT first, then the authored plan index to grade. */
export function renderPlanForReview(input: PlanReviewInput): AgentMessage {
  const decisions = input.decisions.length
    ? input.decisions
        .map((d: Decision) => `  [${d.decisionClass}] ${d.title}: ${d.ruling}`)
        .join('\n')
    : '  (none)';

  const threads = input.threadTitles.length
    ? input.threadTitles
        .map((b, i) => {
          const steps = input.stepsByThread?.[i] ?? [];
          if (!steps.length) return `  ${i + 1}. ${b}`;
          const body = steps
            .map(
              (p, j) =>
                `     ${i + 1}.${j + 1} ${p.title}\n       ${p.brief.replace(/\n/g, '\n       ')}`,
            )
            .join('\n');
          return `  ${i + 1}. ${b}\n${body}`;
        })
        .join('\n')
    : '  (none)';

  const hasPhases = (input.stepsByThread ?? []).some((p) => p.length);

  const authoredPlan = [
    '<authored_plan>',
    'The structured plan Atlas authored. The `/context/specs/` files are authoritative — read them; this is',
    'just the index to orient your reading.',
    '',
    'LOCKED DECISIONS:',
    decisions,
    '',
    hasPhases
      ? 'THREADS (each with its execute-ready steps — the build runs these directly):'
      : 'THREADS (high-level briefs):',
    threads,
    '</authored_plan>',
  ];

  return agentMessage(
    [
      renderReviewIntent(input),
      '',
      ...authoredPlan,
      '',
      'Now judge per <what_to_judge> + <output_contract>. Read the specs and the referenced code first.',
    ].join('\n'),
  );
}

/**
 * Render the task for a RESUMED review (Atlas revised the specs and/or is pushing back). Codex remembers
 * its prior findings from the session history, so this just re-orients it to re-read the live specs and
 * adjudicate per the <output_contract>'s RE-REVIEW rule (concede what's fixed, hold firm on what stands,
 * don't manufacture ever-smaller findings).
 */
export function renderReReview(input: PlanReviewInput, note?: string): AgentMessage {
  return agentMessage(
    [
      '<re_review>',
      'You have reviewed this plan before (your prior findings are in this conversation). Atlas has revised the',
      'specs and/or is responding to your findings. RE-READ the current `/context/specs/` and the referenced',
      'code — do NOT rely on any description of what changed. For EACH prior finding decide: genuinely RESOLVED',
      '(concede it), or does it STILL STAND (hold firm, restate concisely). Only raise something NEW if it is as',
      'serious as a first-pass BLOCKING issue.',
      ...(note?.trim() ? ['', "ATLAS'S NOTE:", note.trim()] : []),
      '</re_review>',
      '',
      'Now output per your <output_contract>: a severity-tagged `FINDING [...]:` line for every issue that STILL',
      'STANDS or is newly revealed, or EXACTLY `NO_FINDINGS` if everything is resolved and the plan achieves the',
      'intent.',
    ].join('\n'),
  );
}
