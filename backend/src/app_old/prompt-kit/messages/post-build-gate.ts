import { agentMessage, type AgentMessage } from '../../../_shared/prompt-kit/message';

export function postBuildGateSeed(): AgentMessage {
  return agentMessage(
    `This build is complete and reviewed, and is now parked at the ship-review gate. You are on a fresh ` +
      `session — reconstruct what shipped from durable artifacts, not memory:\n` +
      `  - \`/context/specs/plan.md\` — what was planned.\n` +
      `  - the per-thread evidence bundles at \`/context/evidence/<NNN>-…/RESULTS.md\` (or the root ` +
      `\`/context/evidence/RESULTS.md\` for a direct build) — what was actually verified.\n` +
      `  - \`git diff origin/<base>...HEAD\` — what the diff actually changes.\n` +
      `\n` +
      `Post ONE short message to the operator: a 1–3 bullet summary of what this build does and what was ` +
      `verified, and OFFER a preview — let the operator know they can tap Preview and you'll spin one up. ` +
      `Do NOT open the PR (that happens at Ship, on a different session) and do NOT re-plan or re-litigate ` +
      `the approach — if the operator asks for changes, you'll amend from here. End your turn with that ` +
      `summary; take no git action now.`,
  );
}
