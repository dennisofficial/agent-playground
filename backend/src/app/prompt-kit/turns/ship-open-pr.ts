/**
 * prompt-kit / turns / ship-open-pr — the in-sandbox open-PR turn (relocated from `Agent.SHIP_OPEN_PR` +
 * a build-ship-local task/body). The host fires ONE `execute` run in the sandbox: Atlas reconciles the branch
 * against its base, pushes, AUTHORS a Claude-Code-style PR body from the real diff + its `/context/artifacts/`
 * evidence bundle, opens the PR, and reports the url via the `report_pr_opened` bridge tool. This is a `turns/`
 * message, NOT an `Agent` — its system prompt is a single self-contained string that composes no shared fragments.
 */
import type { HarnessTurn } from './turn';

/** A single locked decision as rendered into the PR body's host-owned `### Decisions` block. */
export interface DecisionLine {
  title: string;
  decisionClass: string;
  ruling: string;
}

/** The one-shot system prompt for the open-PR turn: reconcile properly, AUTHOR the body, report the url. */
export const SHIP_OPEN_PR_SYSTEM = [
  'You are Atlas finishing a build inside your own sandbox. Your task this turn is to RECONCILE the branch',
  'against its base and publish the completed work as a pull request. You have authenticated git and the',
  '`gh` CLI. First reconcile: `git fetch origin`, and if the base branch has moved since the build started,',
  'integrate it (merge/rebase) and resolve any conflicts PROPERLY — understand both sides, never blindly',
  'take one. Then push the feature branch and open (or find the existing) PR exactly as instructed.',
  '',
  'YOU AUTHOR THE PR BODY. Write it from what you actually shipped — read the real diff against the base and',
  'your evidence bundle in `/context/artifacts/` (its `RESULTS.md` index) — do NOT just restate the plan.',
  'Keep it tight and honest: a short Summary of what changed and a Verification checklist of what you proved.',
  '',
  'GIT SAFETY: NEVER run destructive or irreversible git commands (`push --force`, `reset --hard`, history',
  'rewrites, etc.) unless explicitly instructed. Do NOT make unrelated code changes beyond what a clean',
  'conflict resolution requires. When the PR is open, call the `report_pr_opened` tool with its url — that is',
  'how the host learns the PR; a prose mention is not enough.',
].join('\n');

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

/** Build the open-PR turn: the reconcile → push → author-body → `gh pr create` → `report_pr_opened` steps.
 *  Always pairs a `system` prompt with the task (the return narrows `HarnessTurn.system` to non-optional). */
export function shipOpenPrTurn(args: ShipOpenPrArgs): HarnessTurn & { system: string } {
  const { branch, defaultBranch, title } = args;
  const decisions = args.decisionsBlock.trim();
  const decisionsStep = decisions
    ? `\n     Then append, VERBATIM and unchanged, this decisions block as the final section:\n\n${decisions}\n`
    : '';
  const task =
    `The build is complete on branch \`${branch}\`. RECONCILE against the base, then publish it as a pull ` +
    `request against \`${defaultBranch}\`:\n` +
    `  1. RECONCILE THE BASE. Run \`git fetch origin\`. The base may have MOVED while this build ran, so ` +
    `check for drift: \`git log --oneline HEAD..origin/${defaultBranch}\` (commits on the base you don't ` +
    `have yet). If there are any, integrate them — \`git merge origin/${defaultBranch}\` (or rebase). If that ` +
    `produces MERGE CONFLICTS, resolve them properly (understand both sides — do not blindly take one), then ` +
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
    `\`gh pr edit\` instead of opening a second one.\n` +
    `  4. Report it: call \`report_pr_opened\` with the PR url (\`gh pr create\` prints it, or run ` +
    `\`gh pr view ${branch} --json url -q .url\`). This step is REQUIRED — the host records the PR from that call.`;
  return { system: SHIP_OPEN_PR_SYSTEM, task };
}
