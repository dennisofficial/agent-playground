/**
 * prompt-kit / turns / post-build-gate — the SHIP-REVIEW-GATE initial-message seed, delivered as a
 * harness-turn body onto the fresh post_build session when the driver parks the job for ship review
 * (after master review). Task-ONLY: the post_build turn always runs under the `POST_BUILD` system prompt
 * (grilling/plan-authoring apparatus stripped), so this body carries no `system` string — it only tells the
 * fresh session how to reconstruct what shipped and what to say about it.
 */
import { agentMessage, type AgentMessage } from '@shared/prompt-kit/message';

/**
 * Build the post_build gate seed: reconstruct what shipped from durable artifacts (no live planning
 * transcript to lean on), post one short operator-facing summary, and offer a preview — take no git action.
 */
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
