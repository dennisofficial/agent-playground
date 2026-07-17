import { agentMessage, type AgentMessage } from '@shared/prompt-kit/message';
import { GIT_SAFETY_NOTE } from '@shared/prompt-kit/system/fragments';

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

export interface ShipOpenPrArgs {
  branch: string;
  defaultBranch: string;
  title: string;
}

export function shipOpenPrBody(args: ShipOpenPrArgs): AgentMessage {
  const { branch, defaultBranch, title } = args;
  const quotedBranch = shellQuote(branch);
  const quotedBaseBranch = shellQuote(defaultBranch);
  const quotedBaseRef = shellQuote(`origin/${defaultBranch}`);
  const quotedBaseRange = shellQuote(`HEAD..origin/${defaultBranch}`);
  const quotedTitle = shellQuote(title);
  return agentMessage(
    `It is SHIP TIME: the build is complete on branch \`${branch}\`. Publish it as a pull request against ` +
      `\`${defaultBranch}\` using your own authenticated git + \`gh\`. Work through the steps and END WITH ONE ` +
      `LINE to the operator (the PR url) — this is a build step, not a play-by-play or a conversation.\n` +
      `  1. FREE THE RAM FIRST. Before you touch git, tear down any services left running from the build — ` +
      `the builders (and the master review) may have started servers under the supervisor for testing, and ` +
      `they are just holding memory on a shared host now. Tear the whole fleet down with ` +
      `\`atlas-svc stop-all\` — the reconcile/PR steps below need no running service, and a later review/demo ` +
      `re-derives and boots only what it needs. Do this silently; do NOT add a line about it to the operator ` +
      `(your PR-url line from the final step stays the last thing you say).\n` +
      `  2. RECONCILE THE BASE. Run \`git fetch origin\`, then check for drift: ` +
      `\`git log --oneline ${quotedBaseRange}\` (commits on the base you don't have yet). If there ` +
      `are any, integrate them — \`git merge ${quotedBaseRef}\` (or rebase). If that produces MERGE ` +
      `CONFLICTS, resolve them PROPERLY — understand both sides, never blindly take one — then commit the merge, ` +
      `and re-run the build/tests to confirm the tree still passes after reconciling. (No drift → skip straight ` +
      `to the push.)\n` +
      `  3. Commit anything uncommitted (\`git add -A\` sweeps in everything you wrote for this build), then ` +
      `\`git push -u origin ${quotedBranch}\`. Nothing ` +
      `uncommitted is left behind: the host does NOT commit on your behalf, so if you don't commit it, it ships nowhere.\n` +
      `  4. AUTHOR THE PR BODY yourself, from what you ACTUALLY shipped — run ` +
      `\`git diff ${quotedBaseRef}...HEAD\` for the real change and SCAN \`/context/evidence/\` for any ` +
      `\`RESULTS.md\` evidence bundle(s) — per-thread bundles live at \`/context/evidence/<NNN>-…/RESULTS.md\`, a ` +
      `direct build's at the \`/context/evidence/\` root. Do NOT restate the plan. Compose a Markdown body with ` +
      `these sections:\n` +
      `       ## Summary\n` +
      `       — 1–3 bullets on what the diff actually changes (behavior/mechanism), not a restatement of the plan.\n` +
      `       ## Verification\n` +
      `       — a checklist of what you PROVED, drawn from the evidence bundle: \`- [x]\` for each thing validated ` +
      `(build/tests green, the artifacts you captured), and \`- [ ]\` for any manual check left for the reviewer. ` +
      `If there is no evidence bundle, list the build/test status you do have.` +
      `\n     Then open the PR, passing the body through a SINGLE-QUOTED heredoc so backticks/\`$\`/code fences ` +
      `stay literal (no shell expansion):\n` +
      `       gh pr create --base ${quotedBaseBranch} --head ${quotedBranch} --title ${quotedTitle} --body "$(cat <<'EOF'\n` +
      `       <your markdown body>\n` +
      `       EOF\n` +
      `       )"\n` +
      `     Keep the TITLE under 70 characters (shorten the given title if needed; put detail in the body). Do NOT ` +
      `add any "Generated with Claude" / "Co-Authored-By" attribution. If a PR for this branch already exists, ` +
      `UPDATE it with \`gh pr edit\` instead of opening a second one.\n` +
      `  5. CONFIRM. Reply with ONE short line to the operator containing the PR url ` +
      `(\`gh pr view ${quotedBranch} --json url -q .url\` prints it). The host records the open PR automatically by ` +
      `branch — you do not need to report it any other way.\n` +
      `\n` +
      GIT_SAFETY_NOTE +
      ` Make NO code changes beyond what a clean conflict resolution requires.`,
  );
}
