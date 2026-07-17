import { describe, expect, it } from 'vitest';
import {
  clampEvidenceOutput,
  renderTerminalRecordSummary,
  type VerificationEvidence,
} from '../live-verification-support';

describe('clampEvidenceOutput', () => {
  it('returns short input untouched', () => {
    const s = 'curl -s /health -> {"ready":true}';
    expect(clampEvidenceOutput(s)).toBe(s);
    expect(clampEvidenceOutput(s, 3000)).toBe(s);
  });

  it('returns input at exactly the cap untouched', () => {
    const s = 'x'.repeat(3000);
    expect(clampEvidenceOutput(s, 3000)).toBe(s);
  });

  it('preserves BOTH a head token and a tail token when over cap, with an elision marker', () => {
    // The exact failure class: a decisive token near the END of a long proof must survive.
    const head = 'HEAD_TOKEN_boot_and_login';
    const tail = 'TAIL_TOKEN_effort=high_in_response';
    const s = `${head}${'-'.repeat(5000)}${tail}`;
    const out = clampEvidenceOutput(s, 3000);
    expect(out).toContain(head);
    expect(out).toContain(tail);
    expect(out).toMatch(/…\[\d+ chars elided\]…/);
    // The clamped output is bounded (cap + a short marker), not the full 5000+ chars.
    expect(out.length).toBeLessThan(3200);
  });
});

describe('renderTerminalRecordSummary', () => {
  const ev = (over: Partial<VerificationEvidence>): VerificationEvidence => ({
    kind: 'reported',
    command: '(see outputTail)',
    exitCode: 0,
    outputTail: '',
    ...over,
  });

  it('surfaces a decisive token that sits past char 300 of an outputTail (the ADR-0005 job bug)', () => {
    // Reproduces job 76f0ee2a: the `effort=high` proof landed ~char 900, past the old 300-char slice.
    const outputTail =
      'health check + login curl'.padEnd(900, '.') +
      'RESPONSE BODY: {"effort":"high"}';
    const summary = renderTerminalRecordSummary({
      summary: 'plumbed effort',
      verification: [ev({ outputTail })],
    });
    expect(summary).toContain('"effort":"high"');
  });

  it('never drops a whole evidence item — the LAST (proof) item survives a diagnostics-first array', () => {
    // The report_verification schema orders diagnostics/typecheck FIRST, live proof LAST.
    const verification = [
      ev({
        kind: 'diagnostics',
        command: 'diagnostics',
        outputTail: 'D'.repeat(2500),
      }),
      ev({
        kind: 'typecheck',
        command: 'pnpm typecheck',
        outputTail: 'T'.repeat(2500),
      }),
      ev({
        kind: 'reported',
        command: 'curl /pipeline',
        outputTail: 'PROOF_TOKEN_effort_high',
      }),
    ];
    const summary = renderTerminalRecordSummary({ summary: 's', verification });
    expect(summary).toContain('PROOF_TOKEN_effort_high');
  });
});
