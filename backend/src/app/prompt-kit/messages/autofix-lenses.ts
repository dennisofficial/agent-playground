/**
 * prompt-kit / messages / autofix-lenses — the auto-fix fan-out's per-run task bodies: one (read-only)
 * review pass's prompt for a given lens + context, and the single execute-mode FIX turn's prompt from
 * the deduped, severity-filtered findings. Lens SELECTION/DATA/PARSING (which lenses exist, which run for
 * a thread, and parsing/dedupe of the findings they return) stays in `autofix/autofix-lenses.ts` — this
 * file owns only the agent-facing TEXT.
 */
import { agentMessage, type AgentMessage } from '../message';
import { fence } from '../../prompt-fence';
import type { AutoFixContext, ReviewFinding, ReviewLens } from '../../autofix/autofix.types';

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
  diff: 'ONLY report issues introduced by (or directly within) the change set — never pre-existing issues outside it.',
  holistic:
    'Judge the change as a WHOLE against its stated intent. You MAY read beyond the diff — into the files it touches and the existing code that calls them — to judge integration and completeness. But only FLAG problems THIS change introduced or left incomplete; never report pre-existing debt outside the change\'s responsibility.',
  framework:
    'Report ONLY violations of the injected framework best-practices, and only within the change set — never pre-existing issues outside it, and never a general style opinion the injected guidance does not state.',
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

/** Render the force-injected framework skill bodies as fenced, per-skill labelled blocks for the
 *  `scope:'framework'` lens. Empty (returns '') when nothing was injected — defensive: the driver only
 *  appends the lens when ≥1 skill matched, but a lens must never render a dangling empty contract. */
function frameworkInjection(ctx: AutoFixContext): string {
  const bodies = ctx.frameworkBodies ?? [];
  if (bodies.length === 0) return '';
  const blocks = bodies.map((b) => fence(`framework best-practices: ${b.name}`, b.body)).join('\n\n');
  return `\nFramework best-practices to enforce for THIS pass (authoritative — sourced from the repo's opted-in review skills):\n\n${blocks}\n`;
}

/**
 * The change set the pass reviews — delivered as GIT COMMANDS the reviewer runs itself (it has `Bash`),
 * NOT the full diff inlined. A large diff inlined here would balloon the prompt (and be duplicated across
 * every concurrent lens); pulling it via the reviewer's own tools lets each lens read only what its focus
 * needs and fetch enclosing context on demand. Scoped to `ctx.gitRange` (the thread's start-sha range),
 * falling back to `HEAD` when the driver couldn't resolve one. Mirrors the master-review + external-PR-review
 * surfaces, which already hand the agent a `git diff` / `gh pr diff` command instead of inlining.
 */
function changeSetBlock(ctx: AutoFixContext): string {
  const range = ctx.gitRange ?? 'HEAD';
  const files = ctx.changedFiles?.length
    ? `Changed files (${ctx.changedFiles.length}):\n${ctx.changedFiles.map((f) => `- ${f}`).join('\n')}\n\n`
    : '';
  return (
    `\nThe change set under review (pull it yourself with your tools — do NOT expect it inlined):\n` +
    files +
    `- \`git diff --stat ${range}\` — the map of what changed.\n` +
    `- \`git diff ${range}\` — the full unified diff. On a large change set, page it per file with` +
    ` \`git diff ${range} -- <path>\` rather than reading it all at once, and \`Read\` the enclosing` +
    ` function of each hunk for context.\n`
  );
}

/** Build one read-only review pass's prompt for a given lens + context. */
export function buildReviewPrompt(lens: ReviewLens, ctx: AutoFixContext): AgentMessage {
  const scope = lens.scope ?? 'diff';
  const frameworkBlock = scope === 'framework' ? frameworkInjection(ctx) : '';
  return agentMessage(
    [
      `You are a focused code reviewer. LENS: ${lens.label}.`,
      `\nFocus of THIS pass: ${lens.focus}`,
      `\nWhat the change was meant to do (intent):\n${fence('intent', ctx.intent)}`,
      frameworkBlock,
      changeSetBlock(ctx),
      'This is a READ-ONLY review turn — do not modify any files. You may read files for context.',
      reviewOutputContract(scope),
    ].join('\n'),
  );
}

/** Build the single execute-mode FIX turn's prompt from the deduped, severity-filtered findings. */
export function buildFixPrompt(findings: ReviewFinding[], ctx: AutoFixContext): AgentMessage {
  const list = findings
    .map(
      (f, i) =>
        `${i + 1}. [${f.severity}] ${f.file ?? '(cross-cutting)'} — ${f.title}\n   ${f.detail}`,
    )
    .join('\n');
  return agentMessage(
    [
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
    ].join('\n'),
  );
}
