import { describe, expect, it } from 'vitest';
import {
  DEFAULT_LENSES,
  buildFixPrompt,
  buildReviewPrompt,
  dedupeFindings,
  meetsSeverity,
  parseFindings,
} from './autofix-lenses';
import type { AutoFixContext, ReviewFinding } from './autofix.types';

const ctx: AutoFixContext = {
  worktreePath: '/tmp/wt',
  sandboxKey: { orgId: 'acme', repoId: 'atlas', jobId: 'feat', type: 'autofix' },
  diff: 'diff --git a/x.ts b/x.ts\n+const y = 1;',
  changedFiles: ['src/x.ts'],
  intent: 'add a y constant',
  label: 'backend',
};

describe('parseFindings', () => {
  it('parses a fenced json block and tags the lens', () => {
    const report = `Here are my findings.\n\n\`\`\`json
{ "findings": [ { "severity": "high", "file": "src/x.ts", "title": "Missing null check", "detail": "guard y" } ] }
\`\`\``;
    const found = parseFindings('correctness', report);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({
      lens: 'correctness',
      severity: 'high',
      file: 'src/x.ts',
      title: 'Missing null check',
    });
  });

  it('returns [] on an empty findings array', () => {
    expect(parseFindings('x', '```json\n{ "findings": [] }\n```')).toEqual([]);
  });

  it('returns [] (never throws) on malformed / missing json', () => {
    expect(parseFindings('x', 'no json here at all')).toEqual([]);
    expect(parseFindings('x', '```json\n{ not valid \n```')).toEqual([]);
  });

  it('picks the LAST json block (the contract puts findings last)', () => {
    const report =
      '```json\n{ "findings": [ { "severity": "low", "title": "old" } ] }\n```\n' +
      'updated:\n```json\n{ "findings": [ { "severity": "high", "title": "new" } ] }\n```';
    const found = parseFindings('x', report);
    expect(found).toHaveLength(1);
    expect(found[0].title).toBe('new');
  });

  it('normalizes severity synonyms and defaults unknown to medium', () => {
    const report =
      '```json\n{ "findings": [' +
      '{ "severity": "critical", "title": "a" },' +
      '{ "severity": "nit", "title": "b" },' +
      '{ "severity": "weird", "title": "c" },' +
      '{ "title": "d" } ] }\n```';
    const found = parseFindings('x', report);
    expect(found.map((f) => f.severity)).toEqual(['high', 'low', 'medium', 'medium']);
  });

  it('drops entries without a title', () => {
    const report = '```json\n{ "findings": [ { "severity": "high", "detail": "no title" } ] }\n```';
    expect(parseFindings('x', report)).toEqual([]);
  });
});

describe('dedupeFindings', () => {
  it('collapses same-file near-identical titles, keeping highest severity + union of lenses', () => {
    const findings: ReviewFinding[] = [
      { lens: 'a', severity: 'low', file: 'src/x.ts', title: 'Missing null check.', detail: 'short' },
      {
        lens: 'b',
        severity: 'high',
        file: 'src/x.ts',
        title: 'missing null check',
        detail: 'a longer detail',
      },
    ];
    const out = dedupeFindings(findings);
    expect(out).toHaveLength(1);
    expect(out[0].severity).toBe('high');
    expect(out[0].lens.split('+').sort()).toEqual(['a', 'b']);
    expect(out[0].detail).toBe('a longer detail');
  });

  it('keeps findings in different files distinct', () => {
    const findings: ReviewFinding[] = [
      { lens: 'a', severity: 'medium', file: 'src/x.ts', title: 'same', detail: '' },
      { lens: 'a', severity: 'medium', file: 'src/y.ts', title: 'same', detail: '' },
    ];
    expect(dedupeFindings(findings)).toHaveLength(2);
  });

  it('sorts high severity first', () => {
    const findings: ReviewFinding[] = [
      { lens: 'a', severity: 'low', file: null, title: 'lo', detail: '' },
      { lens: 'a', severity: 'high', file: null, title: 'hi', detail: '' },
      { lens: 'a', severity: 'medium', file: null, title: 'mid', detail: '' },
    ];
    expect(dedupeFindings(findings).map((f) => f.severity)).toEqual(['high', 'medium', 'low']);
  });
});

describe('meetsSeverity', () => {
  it('respects the threshold ordering', () => {
    expect(meetsSeverity('high', 'medium')).toBe(true);
    expect(meetsSeverity('medium', 'medium')).toBe(true);
    expect(meetsSeverity('low', 'medium')).toBe(false);
    expect(meetsSeverity('low', 'low')).toBe(true);
  });
});

describe('prompt builders', () => {
  it('review prompt carries the lens focus, intent, files and diff', () => {
    const p = buildReviewPrompt(DEFAULT_LENSES[0], ctx);
    expect(p).toContain(DEFAULT_LENSES[0].label);
    expect(p).toContain('add a y constant');
    expect(p).toContain('src/x.ts');
    expect(p).toContain('READ-ONLY');
    expect(p).toContain('"findings"');
  });

  it('fix prompt enumerates findings, forbids scope creep, and REQUIRES the agent commit + push', () => {
    const findings: ReviewFinding[] = [
      { lens: 'a', severity: 'high', file: 'src/x.ts', title: 'guard y', detail: 'add a null check' },
    ];
    const p = buildFixPrompt(findings, ctx);
    expect(p).toContain('guard y');
    expect(p).toContain('add a null check');
    expect(p).toContain('SMALLEST');
    // Writers own their commits now — the fix agent commits + pushes its own work (no host commit).
    expect(p).toContain('COMMIT YOUR WORK');
    expect(p).toContain('git push');
  });
});
