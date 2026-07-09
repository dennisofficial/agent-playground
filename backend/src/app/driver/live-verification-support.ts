import type { Decision } from '../domain';

/**
 * Shared inputs/renderers for the ADR-0005 live-verification judge — extracted here so BOTH callers apply
 * the IDENTICAL pre-filter + rendering: the driver's per-thread `complete_thread` gate
 * (`thread-driver.service.ts`) and the brain's direct-build `finalize_build` gate
 * (`agent-session-manager.service.ts`). Keep them here (not duplicated) so the two paths never drift.
 */

/** One piece of live-verification evidence — the real command a build actually ran and its result. */
export interface VerificationEvidence {
  kind: string;
  command: string;
  exitCode: number;
  outputTail: string;
}

/** The minimal terminal-record shape {@link renderTerminalRecordSummary} needs — satisfied by the driver's
 *  `ThreadTerminalRecord` and by a lightweight object the brain builds for direct-build. */
export interface TerminalRecordSummaryInput {
  summary: string;
  changes?: string[];
  verification?: VerificationEvidence[];
  deviations?: string[];
  gaps?: string[];
}

/** Deterministic non-runtime file patterns — the ADR-0005 §2f pre-filter. A changed-file list that is
 *  EMPTY or matches entirely against this never reaches the live-verification judge, in any mode. */
export const NON_RUNTIME_FILE_RE =
  /(^|\/)docs\/|\.md$|\.spec\.ts$|\.test\.ts$|(^|\/)package(-lock)?\.json$|pnpm-lock\.yaml$|yarn\.lock$|(^|\/)\.gitignore$|(^|\/)\.github\//i;

/** Compact rendering of a candidate terminal record for the live-verification judge's input — untrusted,
 *  fenced by the caller. */
export function renderTerminalRecordSummary(
  r: TerminalRecordSummaryInput,
): string {
  const parts = [`Summary: ${r.summary}`];
  parts.push(
    r.changes?.length
      ? `Changes:\n${r.changes.map((c) => `- ${c}`).join('\n')}`
      : 'Changes: (none reported)',
  );
  parts.push(
    r.verification?.length
      ? `Verification:\n${r.verification
          .map(
            (v) =>
              `- [${v.kind}] ${v.command} (exit ${v.exitCode}): ${v.outputTail.slice(0, 300)}`,
          )
          .join('\n')}`
      : 'Verification: (none reported)',
  );
  if (r.deviations?.length)
    parts.push(`Deviations:\n${r.deviations.map((d) => `- ${d}`).join('\n')}`);
  if (r.gaps?.length)
    parts.push(`Gaps:\n${r.gaps.map((g) => `- ${g}`).join('\n')}`);
  return parts.join('\n\n');
}

/** Compact rendering of the locked decisions for the live-verification judge's input — same shape as
 *  the batch-task decisions block. */
export function renderLockedDecisionsSummary(
  record: { decisions: Decision[] } | null,
): string {
  return record?.decisions.length
    ? record.decisions
        .map((d) => `- [${d.decisionClass}] ${d.title}: ${d.ruling}`)
        .join('\n')
    : '(none)';
}
