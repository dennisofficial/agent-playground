/**
 * Pure parsing/(de)serialization for the Codex reviewer's severity-tagged findings output — split out of
 * `plan-review.service.ts` (which pulls in NestJS DI + TypeORM + the full entity barrel) so it can be
 * imported standalone by `plan-review.eval.ts` without dragging the eval CLI through that machinery.
 */

/** One parsed finding — the severity tag drives Atlas's "N blocking, M advisory" summary (never gates). */
export type ReviewFinding = { severity: 'BLOCKING' | 'ADVISORY'; text: string };

/** Parse the reviewer's output into severity-tagged findings. Empty when NO_FINDINGS / no FINDING lines. */
export function parsePlanFindings(reviewerOutput: string): ReviewFinding[] {
  if (/\bNO_FINDINGS\b/i.test(reviewerOutput)) return [];
  const out: ReviewFinding[] = [];
  for (const raw of reviewerOutput.split('\n')) {
    const line = raw.trim();
    const tagged = line.match(/^FINDING\s*\[\s*(BLOCKING|ADVISORY)\s*\]\s*:\s*(.+)$/i);
    if (tagged) {
      out.push({
        severity: tagged[1].toUpperCase() as ReviewFinding['severity'],
        text: tagged[2].trim(),
      });
      continue;
    }
    // Lenient back-compat: a bare `FINDING:` with no severity tag → treat as BLOCKING (surface, don't drop).
    const bare = line.match(/^FINDING\s*:\s*(.+)$/i);
    if (bare) out.push({ severity: 'BLOCKING', text: bare[1].trim() });
  }
  return out;
}

/** Serialize findings for durable storage (`codex_reviews.findings`); '' when clean. */
export function serializeFindings(findings: ReviewFinding[]): string {
  return findings.map((f) => `[${f.severity}] ${f.text}`).join('\n');
}

/** Rehydrate findings from the stored `codex_reviews.findings` string. */
export function deserializeFindings(stored: string | null): ReviewFinding[] {
  if (!stored) return [];
  return parsePlanFindings(
    stored
      .split('\n')
      .map((l) => l.replace(/^\[(BLOCKING|ADVISORY)\]\s*/i, (_m, s) => `FINDING [${s}]: `))
      .join('\n'),
  );
}
