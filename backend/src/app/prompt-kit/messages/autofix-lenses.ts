import { agentMessage, type AgentMessage } from '@shared/prompt-kit/message';
import type { AutoFixContext, ReviewFinding, ReviewLens } from '../../autofix/autofix.types';
import { fence } from '../../prompt-fence';

const REVIEW_OUTPUT_FORMAT = `Return your findings as a SINGLE fenced JSON code block and nothing else after it:

\`\`\`json
{ "findings": [ { "severity": "low|medium|high", "file": "path/relative/to/repo or null", "title": "one line", "detail": "what is wrong + the concrete fix" } ] }
\`\`\``;

const SHIP_BLOCKER_BAR = `Bar for reporting — report ONLY what a senior engineer would raise in a PR review that BLOCKS approval:
- Do NOT report style preferences, restate what a linter/formatter already handles, or nitpick a pattern the surrounding code already accepts.
- An empty report is the correct, expected outcome for a clean change — return { "findings": [] } and never pad it to look thorough.

Assign severity honestly — do NOT inflate:
- high = breaks production, loses data, or is a real bug.
- medium = a real defect or a maintainability problem worth fixing before merge.
- low = minor.
- When unsure an issue truly matters, use low or omit it.`;

const SCOPE_CLAUSE: Record<NonNullable<ReviewLens['scope']>, string> = {
  diff: 'ONLY report issues introduced by (or directly within) the change set — never pre-existing issues outside it.',
  holistic:
    "Judge the change as a WHOLE against its stated intent. You MAY read beyond the diff — into the files it touches and the existing code that calls them — to judge integration and completeness. But only FLAG problems THIS change introduced or left incomplete; never report pre-existing debt outside the change's responsibility.",
  framework:
    'Report ONLY violations of the injected framework best-practices, and only within the change set — never pre-existing issues outside it, and never a general style opinion the injected guidance does not state.',
};

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

function frameworkInjection(ctx: AutoFixContext): string {
  const bodies = ctx.frameworkBodies ?? [];
  if (bodies.length === 0) return '';
  const blocks = bodies
    .map((b) => fence(`framework best-practices: ${b.name}`, b.body))
    .join('\n\n');
  return `\nFramework best-practices to enforce for THIS pass (authoritative — sourced from the repo's opted-in review skills):\n\n${blocks}\n`;
}

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
