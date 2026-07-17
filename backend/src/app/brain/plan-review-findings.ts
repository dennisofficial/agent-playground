
export type ReviewFinding = { severity: 'BLOCKING' | 'ADVISORY'; text: string };

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
    const bare = line.match(/^FINDING\s*:\s*(.+)$/i);
    if (bare) out.push({ severity: 'BLOCKING', text: bare[1].trim() });
  }
  return out;
}

export function serializeFindings(findings: ReviewFinding[]): string {
  return findings.map((f) => `[${f.severity}] ${f.text}`).join('\n');
}

export function deserializeFindings(stored: string | null): ReviewFinding[] {
  if (!stored) return [];
  return parsePlanFindings(
    stored
      .split('\n')
      .map((l) => l.replace(/^\[(BLOCKING|ADVISORY)\]\s*/i, (_m, s) => `FINDING [${s}]: `))
      .join('\n'),
  );
}
