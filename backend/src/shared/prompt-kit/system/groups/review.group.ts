/**
 * prompt-kit / groups / review — the PR-review MISSION for a `kind: 'review'` job.
 *
 * A review job reviews an EXISTING external pull request (see `reviewIdentity`); it never builds. These
 * fragments (gated `isReview`) give it the methodology the normal brain's planning/ship fragments would —
 * how to scope the PR, hunt for real defects, verify them, and present findings. Adapted from Claude Code's
 * own `/review` + `/code-review` system prompts. Ordered ~108x so it sits with orientation (INVESTIGATE
 * FIRST, which a review job KEEPS), after the shared identity/harness-tag preamble.
 */
import { Agent } from '../agent';
import { Fragment, FragmentGroup } from '../fragment.decorator';
import { isReview } from '../conditions';

@FragmentGroup()
export class ReviewGroup {
  /** Scope the PR — the target + how to fetch it. */
  @Fragment({ usedBy: [Agent.ATLAS_MAIN], order: 1082, condition: isReview })
  scope(): string {
    return [
      'SCOPE THE PR. The operator names the PR to review (a `<review>` block on your first turn carries the PR',
      'number, or the operator says it in chat). Gather it with `gh`, NOT a local `git diff`:',
      '  1. `gh pr view <N> --json title,body,author,baseRefName,headRefName,state,additions,deletions,changedFiles,labels`',
      '     for context (what the PR claims to do, and its stated design — hold the diff against it).',
      '  2. `gh pr diff <N>` for the unified diff. THAT diff is the review scope — local working-tree changes',
      '     are out of scope. When an angle needs surrounding code, Read the files in this checkout if it is on',
      "     the PR's branch, otherwise fetch them with `gh`.",
      "For a large diff, delegate the read to the `review` subagent (Task) — give it the diff + the PR's stated",
      'intent and have it come back with candidate findings; you still verify them yourself (below).',
    ].join('\n');
  }

  /** The finder angles — what a real defect looks like. */
  @Fragment({ usedBy: [Agent.ATLAS_MAIN], order: 1084, condition: isReview })
  finderAngles(): string {
    return [
      'HUNT FOR REAL DEFECTS, not style nits. Read every hunk line by line, then Read the enclosing function',
      'for each hunk — a bug in an UNCHANGED line of a touched function is in scope (the PR re-exposes or',
      'fails to fix it). For every change ask: what input, state, timing, or platform makes this wrong? Look',
      'for — inverted/wrong conditions, off-by-one, null/undefined deref, a missing `await`, falsy-zero (`!x`',
      'when 0 is valid), wrong-variable copy-paste, an error swallowed in a catch, unescaped regex metachars,',
      'a resource/lock/handle never released, a changed default or signature that breaks a caller, and',
      "BEHAVIOR SILENTLY REMOVED (a branch/guard/validation deleted). Also flag DRIFT from this repo's own",
      'conventions (you read its CLAUDE.md/AGENTS.md while orienting). Weigh each against the PR body: does the',
      'code actually do what the PR says, and does the PR own any regression it introduces?',
    ].join('\n');
  }

  /** Verify before you report. */
  @Fragment({ usedBy: [Agent.ATLAS_MAIN], order: 1086, condition: isReview })
  verify(): string {
    return [
      'VERIFY EACH FINDING BEFORE YOU REPORT IT. A plausible-looking bug that cannot actually happen is noise',
      'that costs the operator trust. For each candidate, construct the concrete path that triggers it (the',
      'input/state) and confirm the surrounding code does not already prevent it — Read the callers, the',
      "guards, the types. Drop the ones you cannot stand behind. Do not launder a subagent's claim as fact:",
      'if the `review` subagent surfaced it, re-check it yourself. You may run typecheck/tests on the branch',
      'to confirm a suspicion (install deps first if needed) — but a static review with verified findings is a',
      'complete, valuable deliverable on its own.',
    ].join('\n');
  }

  /** Present the review + offer next steps. */
  @Fragment({ usedBy: [Agent.ATLAS_MAIN], order: 1088, condition: isReview })
  present(): string {
    return [
      'PRESENT THE REVIEW to the operator as a normal chat message (never a raw JSON array). Lead with a 2–3',
      'sentence overview of what the PR does and your overall read, then the surviving findings grouped by',
      'severity (🔴 High / 🟡 Medium / 🟢 Low), each as `file:line — one-line summary (the concrete failure it',
      'causes)`. If nothing survived verification, say so plainly — "looks solid" is a valid, useful result.',
      'Then OFFER concrete next steps and stop: post the findings as inline PR review comments (`gh pr review`',
      '/ `gh api …/pulls/<N>/comments`), run typecheck/tests on the branch, or — only if the operator asks —',
      'implement a fix. Do not act on these unprompted; leave the job open for the operator to choose.',
    ].join('\n');
  }
}
