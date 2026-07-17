import type { Decision } from '../../_shared/domain';


export interface VerificationEvidence {
  kind: string;
  command: string;
  exitCode: number;
  outputTail: string;
}

export interface TerminalRecordSummaryInput {
  summary: string;
  changes?: string[];
  verification?: VerificationEvidence[];
  deviations?: string[];
  gaps?: string[];
}

export const NON_RUNTIME_FILE_RE =
  /(^|\/)docs\/|\.md$|\.spec\.ts$|\.test\.ts$|(^|\/)package(-lock)?\.json$|pnpm-lock\.yaml$|yarn\.lock$|(^|\/)\.gitignore$|(^|\/)\.github\//i;

export const BUILD_RELEVANT_FILE_RE =
  /\.(ts|tsx|cts|mts|js|jsx|cjs|mjs)$|(^|\/)package\.json$|(^|\/)tsconfig[^/]*\.json$/i;

export function clampEvidenceOutput(s: string, cap = 3000): string {
  if (s.length <= cap) return s;
  const head = Math.min(1200, Math.floor(cap / 3));
  const tail = cap - head;
  const elided = s.length - head - tail;
  return `${s.slice(0, head)}\n…[${elided} chars elided]…\n${s.slice(s.length - tail)}`;
}

export function renderTerminalRecordSummary(r: TerminalRecordSummaryInput): string {
  const parts = [`Summary: ${r.summary}`];
  parts.push(
    r.changes?.length
      ? `Changes:\n${r.changes.map((c) => `- ${c}`).join('\n')}`
      : 'Changes: (none reported)',
  );
  parts.push(
    r.verification?.length
      ? // Render EVERY evidence item — never drop one. The `verification` array is ordered
        `Verification:\n${r.verification
          .map(
            (v) =>
              `- [${v.kind}] ${v.command} (exit ${v.exitCode}): ${clampEvidenceOutput(v.outputTail)}`,
          )
          .join('\n')}`
      : 'Verification: (none reported)',
  );
  if (r.deviations?.length)
    parts.push(`Deviations:\n${r.deviations.map((d) => `- ${d}`).join('\n')}`);
  if (r.gaps?.length) parts.push(`Gaps:\n${r.gaps.map((g) => `- ${g}`).join('\n')}`);
  return parts.join('\n\n');
}

export function renderLockedDecisionsSummary(record: { decisions: Decision[] } | null): string {
  return record?.decisions.length
    ? record.decisions.map((d) => `- [${d.decisionClass}] ${d.title}: ${d.ruling}`).join('\n')
    : '(none)';
}
