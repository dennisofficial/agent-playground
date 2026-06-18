/**
 * Prompts for the harness-driven PR self-review pipeline (ReviewPipelineService). The review/fix
 * turns are real engine runs — the review on the owner's REVIEW engine (cross-engine, read-only),
 * the fix on the owner's execute session (resumed internally). Reviews must end with a machine
 * VERDICT line so the pipeline can branch without an LLM judge.
 */

/** Per-owner code review: scope the review to the owner's OWN diff range so a later owner never
 * re-reviews a prior owner's already-integrated work. Read-only (investigate mode). */
export const CODE_REVIEW_PROMPT = (p: {
  goal: string;
  ticket: string;
  range: string;
}): string =>
  `You are a code-review agent. Adversarially review ONLY the changes in the git range \`${p.range}\` — run \`git diff ${p.range}\` and read the touched files for context. Find what's WRONG: correctness bugs, broken or unhandled contracts, missing error handling, security issues, obviously-missing tests. Do not praise. This turn is READ-ONLY — do not modify anything.

The work implements:
${p.ticket}

Goal: ${p.goal}

Report concrete, actionable problems with file:line references. If the change is sound and ready, say so in one line.

End your response with EXACTLY ONE of these lines and nothing after it:
VERDICT: PASS
VERDICT: CHANGES`;

/** Fix turn on the owner's execute session — feeds back the review's objections. Execute mode. */
export const REVIEW_FIX_PROMPT = (p: { critique: string }): string =>
  `A self-review of your work flagged the issues below. Fix them here and COMMIT the fixes. Do NOT open or modify any PR — the harness handles publishing once you're done. If a point is wrong or not worth doing, address the rest and note briefly why you skipped it.

REVIEW:
${p.critique}`;

/** Conflict-resolution turn when publishing the owner's branch onto shared hit a merge conflict. */
export const CONFLICT_RESOLVE_PROMPT = (p: {
  sharedBranch: string;
  files: string[];
}): string =>
  `Publishing your work onto the shared branch \`${p.sharedBranch}\` hit a MERGE CONFLICT — the merge is left IN PROGRESS in this workspace. Resolve the conflicts in: ${
    p.files.join(', ') || '(run git status to see them)'
  }, keeping both sides' intent where they don't truly clash, then COMMIT the merge. Don't touch the PR — the harness republishes once the merge is committed.`;

/** Final integration review over the whole shared branch before the PR is readied for Dennis. */
export const INTEGRATION_REVIEW_PROMPT = (p: {
  goal: string;
  ticket: string;
  sharedBranch: string;
  base: string;
}): string =>
  `You are a code-review agent doing the FINAL integration pass before this work goes to Dennis. Review the combined changes on \`${p.sharedBranch}\` versus \`${p.base}\` — run \`git diff ${p.base}...${p.sharedBranch}\`. Focus on whether the pieces fit together: consistent contracts between them, nothing half-wired, no contradictions across the combined work. READ-ONLY.

The work implements:
${p.ticket}

Goal: ${p.goal}

End your response with EXACTLY ONE of these lines and nothing after it:
VERDICT: PASS
VERDICT: CHANGES`;

/** The final TICKET-LEVEL review over the whole feature's accumulated diff before the pipeline ships
 * its PR (Phase 5b) — INTEGRATION_REVIEW_PROMPT scoped to one ticket built section-by-section in ONE
 * workspace. Takes a ready git range (the runner computes base...branch) rather than the shared-branch
 * pair, since the pipeline accumulates on the workspace branch and only publishes at ship time. A
 * `changes` verdict routes to the cross-section-defect decision (Atlas decides) instead of shipping. */
export const FULL_IMPLEMENTATION_REVIEW_PROMPT = (p: {
  goal: string;
  ticket: string;
  range: string;
}): string =>
  `You are a code-review agent doing the FINAL whole-implementation pass before this feature's PR goes to Dennis. The feature was built section-by-section (backend, frontend, …) in ONE workspace; review the COMBINED changes in the git range \`${p.range}\` — run \`git diff ${p.range}\`. Focus on whether the sections fit TOGETHER: consistent contracts across the seams, nothing half-wired between sections, no contradictions or dead ends introduced where one section met another. Per-section reviews already covered each piece in isolation — your job is the integration. READ-ONLY.

The work implements:
${p.ticket}

Goal: ${p.goal}

Report concrete cross-section problems with file:line references. If the combined work hangs together and is ready, say so in one line.

End your response with EXACTLY ONE of these lines and nothing after it:
VERDICT: PASS
VERDICT: CHANGES`;

/** Parse the trailing VERDICT line. Defaults to 'pass' when absent — the review prompt requires the
 * line, so a missing one means a clean/empty review; defaulting to 'changes' would risk a fix loop on
 * an unparseable response. */
export const parseVerdict = (text: string): 'pass' | 'changes' => {
  const m = /VERDICT:\s*(PASS|CHANGES)/i.exec(text);
  return m && m[1].toUpperCase() === 'CHANGES' ? 'changes' : 'pass';
};

/** The advisory-mode PR comment that carries the integration self-review's findings to Dennis on the
 * PR he's about to review (the harness ships the PR ready regardless — this is informational). */
export const SELF_REVIEW_PR_COMMENT = (findings: string): string =>
  `🤖 **Integration self-review** (fresh-eyes, different-engine pass over the combined work)

${findings}

_Advisory only — the PR was readied automatically; nothing here blocked it. Worth a look before merging._`;
