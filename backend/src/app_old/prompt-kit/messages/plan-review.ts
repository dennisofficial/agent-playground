import type { Decision } from '../../../_shared/domain';
import { agentMessage, type AgentMessage } from '../../../_shared/prompt-kit/message';
import type { PlannedStep } from './render-plan';


export type PlanReviewInput = {
  jobId: string;
  orgId: string;
  goal: string;
  overview: string;
  decisions: Decision[];
  threadTitles: string[];
  stepsByThread?: PlannedStep[][];
  note?: string;
};

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
