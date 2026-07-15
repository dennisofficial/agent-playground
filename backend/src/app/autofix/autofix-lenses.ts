/**
 * The review LENSES for the auto-fix fan-out — selection, parsing, and dedupe of the findings each pass
 * returns. Lenses are DATA — the fan-out width is just the selected list's length, so adding a pass =
 * adding a lens, not new control flow. Each review pass is a vanilla `EngineRunner` review-mode turn that
 * must return findings as a single fenced JSON block; the fix turn is one execute-mode turn fed the
 * deduped findings, confined to the worktree. The prompt TEXT for those two turns
 * (`buildReviewPrompt`/`buildFixPrompt`) lives in `prompt-kit/messages/autofix-lenses.ts`.
 *
 * Zero imports from `harness/**` / the v1 surface — pure data/parsing + this subfolder's types.
 */
// Direct path (not the `../thread-kind` barrel, which re-exports `registry.ts` — that file imports
// FROM here, so going through the barrel would cycle). `thread-types.ts` itself imports nothing.
import type { ThreadType } from '../thread-kind/thread-types';
import type { FindingSeverity, ReviewFinding, ReviewLens } from './autofix.types';

/**
 * The two ALWAYS-ON lenses: one narrow diff-scoped CORRECTNESS lens plus one always-on HOLISTIC lens.
 * Correctness stays tightly diff-scoped so its findings are signal-rich; the holistic lens counters that
 * by-design tunnel vision by judging the change as a whole against its intent. Each focus defers to the
 * shared ship-blocker bar in the output contract — the focus says WHAT to look at, the contract says how
 * high the bar is. Callers override via `AutoFixOptions.lenses`.
 */
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

/** Public alias — the always-on lenses, for callers (e.g. `AutoFixOptions.lenses`'s default) that
 *  don't need the type-routed selection below. */
export const DEFAULT_LENSES: ReviewLens[] = ALWAYS_ON;

/**
 * Lenses gated on `thread.type` rather than always-on — composed into the run list by
 * `reviewAgentsForThread` per its routing rules below.
 */
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

/** The conditional FRAMEWORK-CONFORMANCE lens (d4). Appended by `reviewAgentsForThread` only when the
 *  thread has ≥1 applicable `review`-surface skill; its body is force-injected at prompt time (d8 v1 =
 *  one lens carrying the concatenated skill bodies). */
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

/** Every lens definition — `ALWAYS_ON` + `CONDITIONAL` + `FRAMEWORK_LENS` — for id resolution. */
const ALL_LENSES: ReviewLens[] = [...ALWAYS_ON, ...CONDITIONAL, FRAMEWORK_LENS];

/** Resolve a lens by its stable id (a `review_lens` thread's `config.lensId` → the lens definition). */
export function lensById(id: string): ReviewLens | undefined {
  return ALL_LENSES.find((l) => l.id === id);
}

/**
 * THE single source of truth for WHICH review lenses run over a build stage's cumulative diff — the
 * deterministic selection the driver's auto-fix fan-out drives AND the navigator's rendered list both
 * read, so they never drift. Routes on TWO independent axes:
 *  - the owning STAGE's (closed-vocabulary) `type` (moved off `threads.type` onto `stage.type`, d7):
 *    - `docs` drops `correctness` (it assumes executable code — pure noise on prose), leaving `holistic`.
 *    - `data` adds `data_safety` on top of the always-on lenses.
 *    - everything else (`backend`/`frontend`/`infra`/`testing`/`general`) gets the always-on lenses.
 *  - `frameworkSkillNames`: when non-empty (≥1 opted-in `review`-surface skill matched this stage), the
 *    FRAMEWORK_LENS is appended LAST, regardless of `type`.
 * Returns an ordered, deterministic `ReviewLens[]`.
 */
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

/** Severity rank for thresholds + sort (high first). */
const SEVERITY_RANK: Record<FindingSeverity, number> = { low: 0, medium: 1, high: 2 };

/** Is `sev` at least `min`? Drives the fix-turn gate. */
export function meetsSeverity(sev: FindingSeverity, min: FindingSeverity): boolean {
  return SEVERITY_RANK[sev] >= SEVERITY_RANK[min];
}

/**
 * Parse a review pass's report into findings. Tolerant: pulls the LAST fenced ```json block (the
 * contract puts it last), falls back to the first `{...}` object, and drops anything malformed rather
 * than throwing — a single bad pass must not sink the fan-out. Tags every finding with the lens id.
 */
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
    parsed && typeof parsed === 'object' && Array.isArray((parsed as { findings?: unknown }).findings)
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

/** Pull the last fenced ```json … ``` block, else the last bare ``` block, else the first `{…}`. */
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

/**
 * Aggregate + DEDUPE findings across lens passes. Two findings collapse when they share the same file
 * (or both cross-cutting) AND a near-identical normalized title. The survivor keeps the HIGHEST
 * severity and records every lens that flagged it (so the summary shows agreement). Sorted high-first.
 */
export function dedupeFindings(all: ReviewFinding[]): ReviewFinding[] {
  const byKey = new Map<string, ReviewFinding>();
  for (const f of all) {
    const key = `${f.file ?? '*'}::${normalizeTitle(f.title)}`;
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, { ...f });
      continue;
    }
    // Merge: keep highest severity; union the lens tags; prefer the longer detail.
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

/** Normalize a title for dedupe: lowercase, collapse whitespace, drop trailing punctuation. */
function normalizeTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/[`'"]/g, '')
    .replace(/\s+/g, ' ')
    .replace(/[.!?\s]+$/, '')
    .trim();
}
