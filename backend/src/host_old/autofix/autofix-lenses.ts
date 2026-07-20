import type { ThreadType } from '../../_shared/thread-kind/thread-types';
import type { FindingSeverity, ReviewFinding, ReviewLens } from './autofix.types';

const ALWAYS_ON: ReviewLens[] = [
  {
    id: 'correctness',
    label: 'Correctness & smells',
    focus:
      'Logic correctness: off-by-one, null/undefined handling, missed edge cases, incorrect async/' +
      'await or error propagation, resource leaks, and behavior that diverges from the stated intent. ' +
      'Flag only bugs THIS change introduced, not pre-existing ones outside the diff. Pay special ' +
      'attention to REMOVED code that is still referenced: if the change deletes a symbol/file/export, ' +
      'verify nothing in the repo still imports or calls it (including intra-file and dynamic/string ' +
      'references) — a still-referenced deletion is a high-severity bug. Also flag a change that claims ' +
      'to be complete but leaves the build or types broken.',
  },
  {
    id: 'holistic',
    label: 'Holistic: change vs intent',
    scope: 'holistic',
    focus:
      'The change as a WHOLE against its stated intent. Does it actually accomplish the goal? Are all ' +
      'the pieces the intent implies actually present — no half-wired feature, missing call site, ' +
      'unhandled branch, or TODO left where behavior was promised? Do the changed files integrate ' +
      'correctly with each other AND with the existing code that calls them? Flag the cross-file, ' +
      'integration, and completeness problems a narrow lens misses. You MAY read beyond the diff to ' +
      'judge integration, but only flag issues THIS change introduced or left incomplete — never ' +
      'pre-existing debt.',
  },
];

export const DEFAULT_LENSES: ReviewLens[] = ALWAYS_ON;

const CONDITIONAL: ReviewLens[] = [
  {
    id: 'data_safety',
    label: 'Data & migration safety',
    focus:
      'Schema/data-migration safety: destructive or irreversible changes (dropped columns/tables, type ' +
      'narrowing) without a safe rollout; migrations not backwards-compatible with the currently-deployed ' +
      'code, or that lock tables; missing/incorrect down-migration; data loss; unindexed FKs/queries. ' +
      'Prefer expand/contract, backfill, nullable-first — name the safer alternative concretely.',
  },
];

const FRAMEWORK_LENS: ReviewLens = {
  id: 'framework',
  label: 'Framework conformance',
  scope: 'framework',
  focus:
    'Conformance of THIS change to the framework/library best-practices injected below (sourced from the ' +
    "repo's opted-in review skills). Judge ONLY against those documented rules — do not invent general " +
    'style opinions or flag anything the injected guidance does not cover. Flag a violation only where the ' +
    'changed code actually breaks a stated rule, and name the rule + the concrete fix. A change that ' +
    'conforms (or that the injected rules simply do not touch) gets an empty report.',
};

const ALL_LENSES: ReviewLens[] = [...ALWAYS_ON, ...CONDITIONAL, FRAMEWORK_LENS];

export function lensById(id: string): ReviewLens | undefined {
  return ALL_LENSES.find((l) => l.id === id);
}

export function reviewAgentsForThread(
  type: ThreadType,
  frameworkSkillNames: string[] = [],
): ReviewLens[] {
  const base =
    type === 'docs'
      ? ALWAYS_ON.filter((l) => l.id !== 'correctness')
      : type === 'data'
        ? [...ALWAYS_ON, ...CONDITIONAL]
        : ALWAYS_ON;
  return frameworkSkillNames.length > 0 ? [...base, FRAMEWORK_LENS] : base;
}

const SEVERITY_RANK: Record<FindingSeverity, number> = {
  low: 0,
  medium: 1,
  high: 2,
};

export function meetsSeverity(sev: FindingSeverity, min: FindingSeverity): boolean {
  return SEVERITY_RANK[sev] >= SEVERITY_RANK[min];
}

export function parseFindings(lensId: string, report: string): ReviewFinding[] {
  const raw = extractJson(report);
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  const arr =
    parsed &&
    typeof parsed === 'object' &&
    Array.isArray((parsed as { findings?: unknown }).findings)
      ? (parsed as { findings: unknown[] }).findings
      : Array.isArray(parsed)
        ? (parsed as unknown[])
        : [];
  const out: ReviewFinding[] = [];
  for (const item of arr) {
    if (!item || typeof item !== 'object') continue;
    const o = item as Record<string, unknown>;
    const title = typeof o.title === 'string' ? o.title.trim() : '';
    if (!title) continue;
    out.push({
      lens: lensId,
      severity: normalizeSeverity(o.severity),
      file: typeof o.file === 'string' && o.file.trim() ? o.file.trim() : null,
      title,
      detail: typeof o.detail === 'string' ? o.detail.trim() : '',
    });
  }
  return out;
}

function normalizeSeverity(v: unknown): FindingSeverity {
  const s = typeof v === 'string' ? v.toLowerCase() : '';
  if (s === 'high' || s === 'critical') return 'high';
  if (s === 'low' || s === 'minor' || s === 'nit') return 'low';
  return 'medium';
}

function extractJson(text: string): string | null {
  const fenced = [...text.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)].map((m) => m[1].trim());
  for (let i = fenced.length - 1; i >= 0; i--) {
    if (fenced[i].includes('{')) return fenced[i];
  }
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start !== -1 && end > start) return text.slice(start, end + 1);
  return null;
}

export function dedupeFindings(all: ReviewFinding[]): ReviewFinding[] {
  const byKey = new Map<string, ReviewFinding>();
  for (const f of all) {
    const key = `${f.file ?? '*'}::${normalizeTitle(f.title)}`;
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, { ...f });
      continue;
    }
    if (SEVERITY_RANK[f.severity] > SEVERITY_RANK[existing.severity]) {
      existing.severity = f.severity;
    }
    const lenses = new Set(existing.lens.split('+'));
    lenses.add(f.lens);
    existing.lens = [...lenses].join('+');
    if (f.detail.length > existing.detail.length) existing.detail = f.detail;
  }
  return [...byKey.values()].sort((a, b) => SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity]);
}

function normalizeTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/[`'"]/g, '')
    .replace(/\s+/g, ' ')
    .replace(/[.!?\s]+$/, '')
    .trim();
}
