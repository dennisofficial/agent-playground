/**
 * prompt-kit / turns / ship-open-pr — the SHIP-TIME open-PR turn, delivered as a BRAIN harness-turn body
 * (like `LEDGER_PROMOTION_TURN`). The host seeds `shipOpenPrBody(...)` into the job-brain session, which
 * reconciles the branch against its base, pushes, AUTHORS a Claude-Code-style PR body from the real diff +
 * its `/context/artifacts/` evidence bundle, and opens the PR with its own authenticated git + `gh`.
 *
 * Task-ONLY: the brain turn always runs under the `ATLAS_MAIN` system prompt, so this turn carries no
 * `system` string — the reconcile / PR-body / git-safety guidance is folded into the body below. The host
 * learns the PR by BRANCH DISCOVERY after the turn (`findOpenPullByHead` → `setPrReady`, backstopped by the
 * git-state reconciler), so there is NO `report_pr_opened` tool to call — the brain just opens the PR.
 */

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
    ? `\n     Then append, VERBATIM and unchanged, this decisions block as the final section:\n\n${decisions}\n`
    : '';
  return (
    `It is SHIP TIME: the build is complete on branch \`${branch}\`. RECONCILE against the base, then ` +
    `publish it as a pull request against \`${defaultBranch}\`. You have authenticated git and the \`gh\` ` +
    `CLI in this sandbox — this is a build step, not a conversation.\n` +
    `  1. RECONCILE THE BASE. Run \`git fetch origin\`. The base may have MOVED while this build ran, so ` +
    `check for drift: \`git log --oneline HEAD..origin/${defaultBranch}\` (commits on the base you don't ` +
    `have yet). If there are any, integrate them — \`git merge origin/${defaultBranch}\` (or rebase). If that ` +
    `produces MERGE CONFLICTS, resolve them PROPERLY — understand both sides, never blindly take one — then ` +
    `commit the merge. Verify the tree still builds after reconciling.\n` +
    `  2. Commit anything uncommitted, then \`git push -u origin ${branch}\`.\n` +
    `  3. WRITE THE PR BODY yourself, then open the PR. First understand what you shipped: run ` +
    `\`git diff origin/${defaultBranch}...HEAD\` for the real change, and read \`/context/artifacts/RESULTS.md\` ` +
    `(your evidence bundle) if it exists. Then compose a Markdown body with these sections:\n` +
    `       ## Summary\n` +
    `       — 1–3 bullets on what the diff actually changes (behavior/mechanism), not a restatement of the plan.\n` +
    `       ## Verification\n` +
    `       — a checklist of what you PROVED, drawn from the evidence bundle: \`- [x]\` for each thing validated ` +
    `(build/tests green, the artifacts you captured), and \`- [ ]\` for any manual check left for the reviewer. ` +
    `If there is no evidence bundle, list the build/test status you do have.` +
    decisionsStep +
    `\n     Open it: \`gh pr create --base ${defaultBranch} --head ${branch} --title ${JSON.stringify(title)} ` +
    `--body "$(cat <<'EOF'\n<your body>\nEOF\n)"\`. Keep the TITLE under 70 characters (shorten the given ` +
    `title if needed; put detail in the body). If a PR for this branch already exists, UPDATE it with ` +
    `\`gh pr edit\` instead of opening a second one. Once \`gh pr create\`/\`gh pr edit\` reports the PR url, ` +
    `you are done — the host records the open PR automatically.\n` +
    `\n` +
    `GIT SAFETY: NEVER run destructive or irreversible git commands (\`push --force\`, \`reset --hard\`, ` +
    `history rewrites, etc.) unless explicitly instructed, and make NO unrelated code changes beyond what a ` +
    `clean conflict resolution requires.`
  );
}
