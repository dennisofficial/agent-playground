export type Confidence = 'high' | 'medium' | 'low';

/**
 * Pull the self-reported confidence out of an investigation report. The investigate prompt
 * (`DEFAULT_INVESTIGATE_PROMPT`) requires the report to END with a `Confidence: high|medium|low`
 * line, so we scan for the LAST such marker (the trailer) — a mid-report mention of the word can't
 * mislead us. Case-insensitive; tolerates a leading bullet/markdown and trailing punctuation.
 *
 * Returns `null` when no marker is present. Callers fail SAFE on null (no Opus escalation) rather
 * than guessing — we only spend the deeper model when the worker explicitly said it was unsure. The
 * format is one we control, so a regex is the right tool here; if real reports start drifting from
 * the trailer, swap this for a tiny extract-model call (the harness's gate/dedup pattern).
 */
export function investigationConfidence(report: string): Confidence | null {
  const re = /confidence:\s*\**\s*(high|medium|low)\b/gi;
  let last: Confidence | null = null;
  for (const m of report.matchAll(re)) {
    last = m[1].toLowerCase() as Confidence;
  }
  return last;
}
