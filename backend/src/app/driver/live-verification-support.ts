import type { Decision } from '@shared/domain';

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

/**
 * Deterministic pre-filter for the STATIC-check judge — deliberately DIVERGENT from {@link NON_RUNTIME_FILE_RE}
 * (which is right for *live e2e* but wrong for *static checks*). A test file, a `tsconfig`, or a `package.json`
 * is exactly what typecheck/lint/test catches, so those MUST reach the static judge even though the live judge
 * skips them. Fire the static judge iff ≥1 changed file MATCHES this: a code file (a superset of the old Opus
 * gate's `.(ts|tsx|js|jsx)` trigger — `.spec.ts`/`.test.ts` ARE covered) OR build-defining config
 * (`package.json`, `tsconfig*.json`). A diff that matches NONE (pure `.md`/`docs/`, lockfiles, `.github/`,
 * images) is clearly inert to static checks and skips the judge — the downstream Master Review + ship
 * whole-diff typecheck still backstop it.
 */
export const BUILD_RELEVANT_FILE_RE =
  /\.(ts|tsx|cts|mts|js|jsx|cjs|mjs)$|(^|\/)package\.json$|(^|\/)tsconfig[^/]*\.json$/i;

/**
 * Head+TAIL clamp for one piece of evidence output — used at BOTH truncation layers (ingestion in the two
 * producers, and the judge-input renderer) so they never drift. A plain head-only `slice(0, N)` silently
 * dropped the DECISIVE line of a curated proof when it sat past the cut — the exact bug that starved the
 * ADR-0005 judge (job `76f0ee2a…`: the `effort=high` line was past the old 300-char renderer slice).
 *
 * Returns `s` whole when it fits; otherwise keeps a head (context: which command) AND a tail (result:
 * where a curated proof's decisive output usually lands), joined by a visible elision marker so nothing is
 * silently lost from either end. Default cap 3000 sits above the measured prod p99 evidence length (~1921),
 * so essentially all real evidence passes through untouched.
 */
export function clampEvidenceOutput(s: string, cap = 3000): string {
  if (s.length <= cap) return s;
  const head = Math.min(1200, Math.floor(cap / 3));
  const tail = cap - head;
  const elided = s.length - head - tail;
  return `${s.slice(0, head)}\n…[${elided} chars elided]…\n${s.slice(s.length - tail)}`;
}

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
      ? // Render EVERY evidence item — never drop one. The `verification` array is ordered
        // diagnostics/typecheck-first with the live proof LAST, so a list-truncating cap would recreate
        // the starvation bug. Each item is already clamped at ingestion; clamp again defensively (idempotent
        // for already-bounded output) so this renderer is safe even if fed an unclamped record.
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
