import type { Decision, DecisionClass } from '../domain/decision-record';

/**
 * Renders the GENERATED `decision-record.md` from the thread's working-set decisions. This file lives in
 * the read-only `/context/generated/` bucket — it is a projection of the structured `pending_decisions`,
 * NOT a hand-authored doc, so coding agents read it for grounding but never edit it. `log_decision`
 * re-renders it on every call, so it stays incremental and always matches the structured truth.
 */

/** Human labels for the always-ask classes, in the order they render. */
const CLASS_LABELS: Record<DecisionClass, string> = {
  data_model: 'Data model',
  api_contract: 'API contract',
  dependency: 'Dependencies',
  infrastructure: 'Infrastructure',
  cross_cutting: 'Cross-cutting',
  one_way_door: 'One-way doors',
};

const CLASS_ORDER: DecisionClass[] = [
  'data_model',
  'api_contract',
  'dependency',
  'infrastructure',
  'cross_cutting',
  'one_way_door',
];

function renderDecision(d: Decision): string {
  const lines = [`#### ${d.title}`, '', d.ruling];
  if (d.question) {
    lines.push('', `> **Q:** ${d.question}`);
    if (d.answer) lines.push(`> **A:** ${d.answer}`);
  }
  return lines.join('\n');
}

/**
 * Build the full markdown document. Decisions are grouped by class (stable order); empty classes are
 * omitted. An optional `overview` heads the doc. Returns a trailing-newline-terminated string ready to
 * write to `/context/generated/decision-record.md`.
 */
export function renderDecisionRecordMd(decisions: Decision[], overview?: string): string {
  const parts: string[] = ['# Decision record', ''];
  parts.push(
    '_Generated from the locked decisions — do not edit by hand; it is rewritten on every decision._',
    '',
  );
  if (overview && overview.trim()) {
    parts.push('## Overview', '', overview.trim(), '');
  }

  if (decisions.length === 0) {
    parts.push('_No decisions locked yet._', '');
    return parts.join('\n');
  }

  for (const cls of CLASS_ORDER) {
    const inClass = decisions.filter((d) => d.decisionClass === cls);
    if (inClass.length === 0) continue;
    parts.push(`## ${CLASS_LABELS[cls]}`, '');
    for (const d of inClass) {
      parts.push(renderDecision(d), '');
    }
  }

  return parts.join('\n');
}
