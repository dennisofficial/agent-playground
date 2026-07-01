/**
 * The review LENSES for the auto-fix fan-out + the prompt builders for both the (read-only) review
 * passes and the (execute) fix turn. Lenses are DATA — the fan-out width is just the selected list's
 * length, so adding a pass = adding a lens, not new control flow. Each review pass is a vanilla
 * `EngineRunner` review-mode turn that must return findings as a single fenced JSON block; the fix
 * turn is one execute-mode turn fed the deduped findings, confined to the worktree.
 *
 * Zero imports from `harness/**` / the v1 surface — pure strings + this subfolder's types.
 */
import { fence } from '../prompt-fence';
import type {
  AutoFixContext,
  FindingSeverity,
  ReviewFinding,
  ReviewLens,
} from './autofix.types';

/**
 * The default fan-out: three complementary read-only lenses. Conservative + non-overlapping focuses so
 * the deduped union stays signal-rich. Callers override via `AutoFixOptions.lenses`.
 */
export const DEFAULT_LENSES: ReviewLens[] = [
  {
    id: 'best_practices',
    label: 'Best practices & conventions',
    focus:
      'Idiomatic, maintainable code: naming, structure, error handling, dead code, obvious ' +
      'performance/security footguns, and adherence to the language/framework conventions visible in ' +
      'the surrounding files. Do NOT propose broad refactors — only fixes scoped to the change set.',
  },
  {
    id: 'correctness',
    label: 'Correctness & smells',
    focus:
      'Logic correctness: off-by-one, null/undefined handling, missed edge cases, incorrect async/' +
      'await or error propagation, resource leaks, and behavior that diverges from the stated intent. ' +
      'Flag bugs the change introduced, not pre-existing ones outside the diff. Pay special attention to ' +
      'REMOVED code that is still referenced: if the change deletes a symbol/file/export, verify nothing ' +
      'in the repo still imports or calls it (including intra-file and dynamic/string references) — a ' +
      'still-referenced deletion is a high-severity bug. Also flag changes that claim to be complete but ' +
      'leave the build/types broken.',
  },
  {
    id: 'consistency',
    label: 'Consistency with the codebase',
    focus:
      'Consistency with existing patterns in this repo: does the new code match how the codebase ' +
      'already does logging, DI, types, imports, file placement, and tests? Read neighbouring files ' +
      'to judge the house style; flag deviations the change introduced.',
  },
];

/** One review agent as the `/pipeline` read-model surfaces it: a stable id + a human label. */
export interface ReviewAgentInfo {
  id: string;
  label: string;
}

/**
 * The review agents SELECTED TO RUN over a thread's diff — the list the navigator renders. Seam-only
 * today: every thread gets the fixed `DEFAULT_LENSES` set (the auto-fix fan-out runs exactly these), so
 * the rendered list matches what actually executes. The `thread` arg is the future hook point for
 * scope-/condition-based selection (review agents chosen like skills, gated per thread); it is
 * intentionally unused now. This is the SELECTED RUN LIST, not a public catalog — the lens definitions,
 * focuses, and any future gating metadata stay private to the backend.
 */
export function reviewAgentsForThread(_thread?: { type?: string }): ReviewAgentInfo[] {
  return DEFAULT_LENSES.map((l) => ({ id: l.id, label: l.label }));
}

/** Severity rank for thresholds + sort (high first). */
const SEVERITY_RANK: Record<FindingSeverity, number> = { low: 0, medium: 1, high: 2 };

/** Is `sev` at least `min`? Drives the fix-turn gate. */
export function meetsSeverity(sev: FindingSeverity, min: FindingSeverity): boolean {
  return SEVERITY_RANK[sev] >= SEVERITY_RANK[min];
}

/** The contract every review pass must satisfy — appended to each lens prompt. */
const REVIEW_OUTPUT_CONTRACT = `
Return your findings as a SINGLE fenced JSON code block and nothing else after it:

\`\`\`json
{ "findings": [ { "severity": "low|medium|high", "file": "path/relative/to/repo or null", "title": "one line", "detail": "what is wrong + the concrete fix" } ] }
\`\`\`

Rules:
- ONLY report issues introduced by (or directly within) the change set below — never pre-existing
  issues outside it, and never style opinions the surrounding code already violates.
- If the change set is clean, return { "findings": [] }.
- Keep each finding scoped to a concrete, safe fix. No speculative rewrites.
- "file" must be repo-relative (or null for a cross-cutting note).`;

/** Build one read-only review pass's prompt for a given lens + context. */
export function buildReviewPrompt(lens: ReviewLens, ctx: AutoFixContext): string {
  const files = ctx.changedFiles?.length
    ? `\nChanged files:\n${ctx.changedFiles.map((f) => `- ${f}`).join('\n')}\n`
    : '';
  const diffBlock = ctx.diff
    ? `\nDiff under review:\n\n\`\`\`diff\n${ctx.diff}\n\`\`\`\n`
    : '\n(No diff was supplied — inspect the worktree git state to review the change set.)\n';
  return [
    `You are a focused code reviewer. LENS: ${lens.label}.`,
    `\nFocus of THIS pass: ${lens.focus}`,
    `\nWhat the change was meant to do (intent):\n${fence('intent', ctx.intent)}`,
    files,
    diffBlock,
    'This is a READ-ONLY review turn — do not modify any files. You may read files for context.',
    REVIEW_OUTPUT_CONTRACT,
  ].join('\n');
}

/** Build the single execute-mode FIX turn's prompt from the deduped, severity-filtered findings. */
export function buildFixPrompt(findings: ReviewFinding[], ctx: AutoFixContext): string {
  const list = findings
    .map(
      (f, i) =>
        `${i + 1}. [${f.severity}] ${f.file ?? '(cross-cutting)'} — ${f.title}\n   ${f.detail}`,
    )
    .join('\n');
  return [
    'You are applying a curated set of review fixes to the current worktree. Make the SMALLEST',
    'changes that resolve each finding below. Do NOT do unrelated refactors, do NOT touch files',
    'outside this worktree, and do NOT change behavior beyond what the finding calls for. If a finding',
    'is wrong or unsafe to apply, SKIP it and note why — never invent work.',
    `\nWhat the change was meant to do (intent):\n${fence('intent', ctx.intent)}`,
    `\nFindings to address:\n${fence('findings', list)}`,
    '\nWhen done, end with a short summary of exactly which findings you fixed and which you skipped',
    '(and why). Do not commit — the harness commits your changes.',
  ].join('\n');
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
