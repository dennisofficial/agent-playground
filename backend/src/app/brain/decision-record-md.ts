import type { Decision } from '@shared/domain/decision-record';
import { DECISION_CLASS_IDS, DECISION_CLASS_META } from '@shared/domain/decision-record';


function renderDecision(d: Decision): string {
  const lines = [`#### ${d.title}`, '', d.ruling];
  if (d.question) {
    lines.push('', `> **Q:** ${d.question}`);
    if (d.answer) lines.push(`> **A:** ${d.answer}`);
  }
  lines.push(
    '',
    d.confirmedByOperator
      ? '**Status:** Confirmed by the operator.'
      : '**Status:** Authored by Atlas — a provisional default, NOT confirmed by the operator. Treat as not-yet-settled.',
  );
  return lines.join('\n');
}

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

  for (const cls of DECISION_CLASS_IDS) {
    const inClass = decisions.filter((d) => d.decisionClass === cls);
    if (inClass.length === 0) continue;
    parts.push(`## ${DECISION_CLASS_META.find((c) => c.id === cls)!.heading}`, '');
    for (const d of inClass) {
      parts.push(renderDecision(d), '');
    }
  }

  return parts.join('\n');
}
