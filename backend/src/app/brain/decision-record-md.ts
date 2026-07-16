import {
  DECISION_CLASS_IDS,
  DECISION_CLASS_META,
} from '@shared/domain/decision-record';
import type { Decision } from '@shared/domain/decision-record';

/**
 * Renders the GENERATED `decision-record.md` from the thread's working-set decisions. This file lives in
 * the read-only `/context/generated/` bucket — it is a projection of the structured `pending_decisions`,
 * NOT a hand-authored doc, so coding agents read it for grounding but never edit it. Every decision
 * mutation re-renders it, so it stays incremental and always matches the structured truth.
 */

function renderDecision(d: Decision): string {
  const lines = [`#### ${d.title}`, '', d.ruling];
  if (d.question) {
    lines.push('', `> **Q:** ${d.question}`);
    if (d.answer) lines.push(`> **A:** ${d.answer}`);
  }
  // PROVENANCE — an explicit, unambiguous status line. Downstream LLM consumers (the Codex plan reviewer,
  // the step worker) read this file as the locked record; an Atlas-authored DEFAULT must NOT be mistaken
  // for a settled operator call, so spell it out rather than relying on a glyph.
  lines.push(
    '',
    d.confirmedByOperator
      ? '**Status:** Confirmed by the operator.'
      : '**Status:** Authored by Atlas — a provisional default, NOT confirmed by the operator. Treat as not-yet-settled.',
  );
  return lines.join('\n');
}

/**
 * Build the full markdown document. Decisions are grouped by class (stable order); empty classes are
 * omitted. An optional `overview` heads the doc. Returns a trailing-newline-terminated string ready to
 * write to `/context/generated/decision-record.md`.
 */
export function renderDecisionRecordMd(
  decisions: Decision[],
  overview?: string,
): string {
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
    parts.push(
      `## ${DECISION_CLASS_META.find((c) => c.id === cls)!.heading}`,
      '',
    );
    for (const d of inClass) {
      parts.push(renderDecision(d), '');
    }
  }

  return parts.join('\n');
}
