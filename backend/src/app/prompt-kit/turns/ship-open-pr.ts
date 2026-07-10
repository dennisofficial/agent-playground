/**
 * prompt-kit / turns / ship-open-pr — the SHIP-TIME open-PR turn, delivered as a BRAIN harness-turn body.
 * The host seeds `shipOpenPrBody(...)` into the job-brain session, which
 * reconciles the branch against its base, pushes, AUTHORS a Claude-Code-style PR body from the real diff +
 * its `/context/artifacts/` evidence bundle, and opens the PR with its own authenticated git + `gh`.
 *
 * Task-ONLY: the brain turn always runs under the `ATLAS_MAIN` system prompt, so this turn carries no
 * `system` string — the reconcile / PR-body / git-safety guidance is folded into the body below. The host
 * learns the PR by BRANCH DISCOVERY after the turn (`findOpenPullByHead` → `setPrReady`, backstopped by the
 * git-state reconciler), so there is NO `report_pr_opened` tool to call — the brain just opens the PR.
 */
import { GIT_SAFETY_NOTE } from '../fragments';

/** A single locked decision as rendered into the PR body's host-owned `### Decisions` block. */
export interface DecisionLine {
  title: string;
  decisionClass: string;
  ruling: string;
}

/** The host-owned `### Decisions` block for the PR body — rendered from the locked decisions, or '' if none.
 *  The brain pastes this VERBATIM so the locked decisions are never dropped or paraphrased. */
export function decisionsBlock(decisions: ReadonlyArray<DecisionLine>): string {
  if (!decisions.length) return '';
  return [
    '### Decisions',
    ...decisions.map((d) => `- **${d.title}** (${d.decisionClass}): ${d.ruling}`),
  ].join('\n');
}

export interface ShipOpenPrArgs {
  /** The feature branch that carries the build. */
  branch: string;
  /** The base branch the PR targets. */
  defaultBranch: string;
  /** The job title → the PR title (the brain trims it under 70 chars). */
  title: string;
  /** The pre-rendered host-owned `### Decisions` block to paste verbatim (see `decisionsBlock`); '' when none. */
  decisionsBlock: string;
}

/**
 * Build the open-PR turn BODY (task-only) seeded into the brain: reconcile → push → author-body →
 * `gh pr create`. No `report_pr_opened` step — the host records the PR by branch discovery after the turn.
 */
export function shipOpenPrBody(args: ShipOpenPrArgs): string {
  const { branch, defaultBranch, title } = args;
  const decisions = args.decisionsBlock.trim();
  const decisionsStep = decisions
    ? `\n     Append this block to the body VERBATIM and unchanged, as its final section:\n\n${decisions}\n`
    : '';
  return (
    `It is SHIP TIME: the build is complete on branch \`${branch}\`. Publish it as a pull request against ` +
    `\`${defaultBranch}\` using your own authenticated git + \`gh\`. Work through the steps and END WITH ONE ` +
    `LINE to the operator (the PR url) — this is a build step, not a play-by-play or a conversation.\n` +
    `  1. RECONCILE THE BASE. Run \`git fetch origin\`, then check for drift: ` +
    `\`git log --oneline HEAD..origin/${defaultBranch}\` (commits on the base you don't have yet). If there ` +
    `are any, integrate them — \`git merge origin/${defaultBranch}\` (or rebase). If that produces MERGE ` +
    `CONFLICTS, resolve them PROPERLY — understand both sides, never blindly take one — then commit the merge, ` +
    `and re-run the build/tests to confirm the tree still passes after reconciling. (No drift → skip straight ` +
    `to the push.)\n` +
    `  2. Commit anything uncommitted (\`git add -A\` sweeps in everything you wrote for this build), then ` +
    `\`git push -u origin ${branch}\`. Nothing ` +
    `uncommitted is left behind: the host does NOT commit on your behalf, so if you don't commit it, it ships nowhere.\n` +
    `  3. AUTHOR THE PR BODY yourself, from what you ACTUALLY shipped — run ` +
    `\`git diff origin/${defaultBranch}...HEAD\` for the real change and read \`/context/artifacts/RESULTS.md\` ` +
    `(your evidence bundle) if it exists. Do NOT restate the plan. Compose a Markdown body with these sections:\n` +
    `       ## Summary\n` +
    `       — 1–3 bullets on what the diff actually changes (behavior/mechanism), not a restatement of the plan.\n` +
    `       ## Verification\n` +
    `       — a checklist of what you PROVED, drawn from the evidence bundle: \`- [x]\` for each thing validated ` +
    `(build/tests green, the artifacts you captured), and \`- [ ]\` for any manual check left for the reviewer. ` +
    `If there is no evidence bundle, list the build/test status you do have.` +
    decisionsStep +
    `\n     Then open the PR, passing the body through a SINGLE-QUOTED heredoc so backticks/\`$\`/code fences ` +
    `stay literal (no shell expansion):\n` +
    `       gh pr create --base ${defaultBranch} --head ${branch} --title ${JSON.stringify(title)} --body "$(cat <<'EOF'\n` +
    `       <your markdown body>\n` +
    `       EOF\n` +
    `       )"\n` +
    `     Keep the TITLE under 70 characters (shorten the given title if needed; put detail in the body). Do NOT ` +
    `add any "Generated with Claude" / "Co-Authored-By" attribution. If a PR for this branch already exists, ` +
    `UPDATE it with \`gh pr edit\` instead of opening a second one.\n` +
    `  4. CONFIRM. Reply with ONE short line to the operator containing the PR url ` +
    `(\`gh pr view ${branch} --json url -q .url\` prints it). The host records the open PR automatically by ` +
    `branch — you do not need to report it any other way.\n` +
    `  5. FREE THE RAM. The build is shipped and the container stays up for review, but any services you ` +
    `started under the supervisor are just holding memory on a shared host now. Tear the whole fleet down ` +
    `with \`atlas-svc stop-all\` — a later review/demo re-derives and boots only what it needs. Do this ` +
    `silently; do NOT add a line about it to the operator (your PR-url line from step 4 stays the last ` +
    `thing you say).\n` +
    `\n` +
    GIT_SAFETY_NOTE +
    ` Make NO code changes beyond what a clean conflict resolution requires.`
  );
}
