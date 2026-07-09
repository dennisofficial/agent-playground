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
 * The default fan-out: four narrow diff-scoped lenses plus one always-on HOLISTIC lens. The four narrow
 * lenses are complementary + non-overlapping so the deduped union stays signal-rich; the holistic lens
 * counters their by-design tunnel vision by judging the change as a whole against its intent. Each focus
 * defers to the shared ship-blocker bar in the output contract — the focus says WHAT to look at, the
 * contract says how high the bar is. Callers override via `AutoFixOptions.lenses`.
 */
export const DEFAULT_LENSES: ReviewLens[] = [
  {
    id: 'best_practices',
    label: 'Best practices & conventions',
    focus:
      'Genuine best-practice defects this change introduces: broken or missing error handling, ' +
      'resource or security footguns, dead/unreachable code, and clear breaks from a language or ' +
      'framework convention the surrounding files consistently follow. Do NOT flag naming, formatting, ' +
      'or stylistic taste — defer to the ship-blocker bar. No broad refactors; only fixes scoped to the ' +
      'change set.',
  },
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
    id: 'consistency',
    label: 'Consistency with the codebase',
    focus:
      "Consistency with THIS repo's established patterns for logging, DI, types, imports, file " +
      'placement, and tests. Read neighbouring files to judge the house style, then flag a deviation ' +
      'only when the surrounding code is actually consistent and this change breaks it in a way that ' +
      'would mislead a maintainer — not where it merely differs in taste. Defer to the ship-blocker bar.',
  },
  {
    id: 'minimalism',
    label: 'Minimal code / no over-engineering',
    focus:
      'Over-engineering THIS change introduces: a new abstraction, dependency, service, wrapper, or ' +
      'config where reuse of something already in the repo, the stdlib, a native platform feature, or a ' +
      'one-liner would do; needless indirection; speculative flexibility or options nobody asked for. ' +
      'Flag the leaner alternative concretely. NEVER flag input validation, error handling, security, or ' +
      'accessibility as "excess" — those are required. No broad refactors; only reductions scoped to the ' +
      'change set.',
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
      'integration, and completeness problems the narrow lenses miss. You MAY read beyond the diff to ' +
      'judge integration, but only flag issues THIS change introduced or left incomplete — never ' +
      'pre-existing debt.',
  },
];

/** One review agent as the `/pipeline` read-model surfaces it: a stable id + a human label. */
export interface ReviewAgentInfo {
  id: string;
  label: string;
}

/** Resolve a lens by its stable id (a `review_lens` thread's `config.lensId` → the lens definition). */
export function lensById(id: string): ReviewLens | undefined {
  return DEFAULT_LENSES.find((l) => l.id === id);
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

/** The JSON shape every review pass returns — identical across scopes, so parse + dedupe are untouched. */
const REVIEW_OUTPUT_FORMAT = `Return your findings as a SINGLE fenced JSON code block and nothing else after it:

\`\`\`json
{ "findings": [ { "severity": "low|medium|high", "file": "path/relative/to/repo or null", "title": "one line", "detail": "what is wrong + the concrete fix" } ] }
\`\`\``;

/**
 * The ship-blocker bar + honest-severity rubric — shared by EVERY scope. This is the anti-nitpicking
 * lever: the post-review fix pass only acts on findings >= medium, so an honest severity here directly
 * shrinks what the fix pass churns on (no threshold change needed).
 */
const SHIP_BLOCKER_BAR = `Bar for reporting — report ONLY what a senior engineer would raise in a PR review that BLOCKS approval:
- Do NOT report style preferences, restate what a linter/formatter already handles, or nitpick a pattern the surrounding code already accepts.
- An empty report is the correct, expected outcome for a clean change — return { "findings": [] } and never pad it to look thorough.

Assign severity honestly — do NOT inflate:
- high = breaks production, loses data, or is a real bug.
- medium = a real defect or a maintainability problem worth fixing before merge.
- low = minor.
- When unsure an issue truly matters, use low or omit it.`;

/** The scope clause — how far the pass may look. The narrow lenses stay diff-only; holistic may read out. */
const SCOPE_CLAUSE: Record<NonNullable<ReviewLens['scope']>, string> = {
  diff: 'ONLY report issues introduced by (or directly within) the change set below — never pre-existing issues outside it.',
  holistic:
    'Judge the change as a WHOLE against its stated intent. You MAY read beyond the diff — into the files it touches and the existing code that calls them — to judge integration and completeness. But only FLAG problems THIS change introduced or left incomplete; never report pre-existing debt outside the change\'s responsibility.',
};

/** The output contract appended to a review pass, tuned to the lens's scope (shared bar + format). */
function reviewOutputContract(scope: NonNullable<ReviewLens['scope']>): string {
  return `
Scope of what you may report:
- ${SCOPE_CLAUSE[scope]}

${SHIP_BLOCKER_BAR}

${REVIEW_OUTPUT_FORMAT}

Rules:
- Keep each finding scoped to a concrete, safe fix. No speculative rewrites.
- "file" must be repo-relative (or null for a cross-cutting note).`;
}

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
    reviewOutputContract(lens.scope ?? 'diff'),
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
    '\nCOMMIT YOUR WORK (required — the host does NOT commit for you): if you changed any files, run',
    '`git add -A` (respect `.gitignore`; if build or cache junk appears in `git status`, add it to',
    '`.gitignore` instead of committing it), commit with a clear message, and `git push` your branch.',
    'Leave the working tree CLEAN. If you fixed nothing, leave the tree untouched (no commit).',
    '\nWhen done, end with a short summary of exactly which findings you fixed and which you skipped',
    '(and why).',
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
